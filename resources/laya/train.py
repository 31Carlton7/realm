"""Fine-tune a Laya checkpoint on the questions Realm asks it, on this Mac.

    python train.py --base <checkpoint dir> --train train.jsonl --calib calib.jsonl [--valid valid.jsonl] --out <dir>

The recipe is Laya's own (RLCD, from the repository's typed-decisions notebook): a policy-gradient
term on noisy copies of the logits scored by laya's strictly proper reward, plus a soft cross-entropy
guide, AdamW with a slower rate for the encoder than for the decision head, cosine decay, clipped
gradients. What changed for a Mac: one process instead of DDP, MPS instead of CUDA, full precision
instead of fp16 with a gradient scaler (MPS has no scaler, and fp32 costs little at these sizes), the
lower encoder layers frozen so the optimizer fits beside everything else in unified memory, and
batches grouped by length so short questions do not pay for long ones.

Rows are JSONL of {"state", "questions", "targets"}: questions exactly as Realm sends them to
laya-serve, and per question the answer distribution in option order. Items are built with laya's own
`Agent._to_internal` and `build_sequence`, so a question is tokenized here exactly as it is served.

After training, temperatures are fitted per option-count bucket on the calibration rows (the
benchmark's train split, never trained on), clamped to the range laya applies. With validation rows,
each epoch is scored on them and the best epoch is the one written.

Progress goes to stdout as JSON lines ({"event": ...}), for Realm to read.
"""
import argparse
import json
import math
import os
import random
import shutil
import signal
import sys
import time

import torch
from safetensors.torch import load_file, save_file

from laya.agent import Agent, _fix_tokenizer_config, _load_tokenizer
from laya.common import QTYPES, TEMP_MAX, TEMP_MIN, build_model, build_sequence, proper_reward, temp_bucket


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def read_rows(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def items_of(rows, tok, cfg):
    """One item per question: token ids, option markers, question type and target distribution."""
    items, dropped = [], 0
    for r in rows:
        for qid, qdef in r["questions"].items():
            q = Agent._to_internal(qdef)
            ids, markers = build_sequence(tok, r["state"], q, cfg.get("max_len", 512), cfg.get("head_max_len", 192))
            target = r["targets"][qid]
            if len(markers) != len(target) or sum(target) <= 0:
                dropped += 1
                continue
            s = float(sum(target))
            items.append({"ids": ids, "markers": markers, "qtype": QTYPES[q["t"]], "target": [t / s for t in target], "kind": r.get("kind", "")})
    return items, dropped


def collate(items, pad_id):
    n, L = len(items), max(len(it["ids"]) for it in items)
    kmax = max(len(it["markers"]) for it in items)
    ids = torch.full((n, L), pad_id, dtype=torch.long)
    att = torch.zeros((n, L), dtype=torch.long)
    mpos = torch.zeros((n, kmax), dtype=torch.long)
    mmask = torch.zeros((n, kmax), dtype=torch.bool)
    target = torch.zeros((n, kmax), dtype=torch.float32)
    for i, it in enumerate(items):
        ids[i, : len(it["ids"])] = torch.tensor(it["ids"])
        att[i, : len(it["ids"])] = 1
        k = len(it["markers"])
        mpos[i, :k] = torch.tensor(it["markers"])
        mmask[i, :k] = True
        target[i, :k] = torch.tensor(it["target"], dtype=torch.float32)
    return {"input_ids": ids, "attention_mask": att, "marker_pos": mpos, "marker_mask": mmask,
            "target": target, "qtype": torch.tensor([it["qtype"] for it in items])}


def batches(items, size, rnd):
    """Shuffled, then grouped by length inside windows of 16 batches: little padding, still random."""
    order = list(range(len(items)))
    rnd.shuffle(order)
    out = []
    window = size * 16
    for w in range(0, len(order), window):
        chunk = sorted(order[w:w + window], key=lambda i: len(items[i]["ids"]))
        out.extend(chunk[b:b + size] for b in range(0, len(chunk), size))
    rnd.shuffle(out)
    return out


def forward(model, b, device):
    return model(b["input_ids"].to(device), b["attention_mask"].to(device), b["marker_pos"].to(device),
                 b["marker_mask"].to(device), b["qtype"].to(device))


@torch.no_grad()
def logits_of(model, items, pad_id, device, size=16):
    model.eval()
    out = []
    order = sorted(range(len(items)), key=lambda i: len(items[i]["ids"]))
    for s in range(0, len(order), size):
        part = [items[i] for i in order[s:s + size]]
        logits, _ = forward(model, collate(part, pad_id), device)
        z = logits.float().cpu()
        for row, it in zip(z, part):
            out.append((it, row[: len(it["markers"])].clone()))
    model.train()
    return out


def score(pairs):
    """Top-1 against the target's argmax, per kind — what the evaluation counts."""
    by = {}
    for it, z in pairs:
        ok = int(torch.argmax(z)) == max(range(len(it["target"])), key=lambda i: it["target"][i])
        right, n = by.get(it["kind"], (0, 0))
        by[it["kind"]] = (right + ok, n + 1)
    return {k: round(r / n, 4) for k, (r, n) in by.items()}


def fit_temperature(pairs):
    """The temperature minimising the calibration rows' negative log-likelihood (the notebook's fit)."""
    if len(pairs) < 10:
        return None
    kmax = max(len(z) for _, z in pairs)
    Z = torch.full((len(pairs), kmax), -1e4)
    T = torch.zeros((len(pairs), kmax))
    for i, (it, z) in enumerate(pairs):
        Z[i, : len(z)] = z
        T[i, : len(z)] = torch.tensor(it["target"])
    log_t = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=100)

    def closure():
        opt.zero_grad()
        loss = -(T * torch.log_softmax(Z / log_t.exp(), -1)).sum(-1).mean()
        loss.backward()
        return loss

    opt.step(closure)
    return float(min(TEMP_MAX, max(TEMP_MIN, log_t.exp().item())))


def save(model, base, out, cfg):
    tmp = out + ".partial"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    save_file({k: v.detach().half().contiguous().cpu() for k, v in model.state_dict().items()}, os.path.join(tmp, "model.safetensors"))
    for sub in ("encoder", "tokenizer"):
        shutil.copytree(os.path.join(base, sub), os.path.join(tmp, sub), symlinks=False)
    with open(os.path.join(tmp, "rl_agent_config.json"), "w") as f:
        json.dump(cfg, f, indent=2)
    shutil.rmtree(out, ignore_errors=True)
    os.replace(tmp, out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--train", required=True)
    ap.add_argument("--calib", required=True)
    ap.add_argument("--valid")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--accum", type=int, default=2)
    ap.add_argument("--lr-encoder", type=float, default=2e-5)
    ap.add_argument("--lr-head", type=float, default=1e-4)
    ap.add_argument("--freeze", type=int, default=12, help="encoder layers kept as they are, from the bottom")
    ap.add_argument("--sigma", type=float, nargs=2, default=(0.4, 0.1))
    ap.add_argument("--group", type=int, default=4)
    ap.add_argument("--seed", type=int, default=20260929)
    ap.add_argument("--device", default="mps")
    args = ap.parse_args()

    signal.signal(signal.SIGTERM, lambda *_: (emit("stopped"), sys.exit(143)))
    torch.manual_seed(args.seed)
    rnd = random.Random(args.seed)
    device = torch.device(args.device if args.device != "mps" or torch.backends.mps.is_available() else "cpu")

    _fix_tokenizer_config(args.base)
    with open(os.path.join(args.base, "rl_agent_config.json")) as f:
        cfg = json.load(f)
    tok = _load_tokenizer(os.path.join(args.base, "tokenizer"), cfg)
    train, dropped = items_of(read_rows(args.train), tok, cfg)
    calib, _ = items_of(read_rows(args.calib), tok, cfg)
    valid = items_of(read_rows(args.valid), tok, cfg)[0] if args.valid else []
    emit("data", train=len(train), dropped=dropped, calib=len(calib), valid=len(valid), device=str(device))

    model = build_model(cfg, encoder_dir=os.path.join(args.base, "encoder"), pretrained=False)
    model.load_state_dict(load_file(os.path.join(args.base, "model.safetensors")), strict=True)
    model.float()
    frozen = [model.encoder.embeddings] + list(model.encoder.layers[: args.freeze])
    for module in frozen:
        for p in module.parameters():
            p.requires_grad_(False)
    model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.head_checkpointing = True
    model.to(device).train()

    enc = [p for n, p in model.named_parameters() if p.requires_grad and n.startswith("encoder.")]
    head = [p for n, p in model.named_parameters() if p.requires_grad and not n.startswith("encoder.")]
    opt = torch.optim.AdamW([{"params": enc, "lr": args.lr_encoder}, {"params": head, "lr": args.lr_head}], weight_decay=0.01)
    per_epoch = math.ceil(len(train) / args.batch)
    total = max(1, per_epoch * args.epochs // args.accum)
    warm = max(1, total // 20)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * (0.05 + 0.95 * 0.5 * (1 + math.cos(math.pi * min(1.0, s / total)))))

    base_valid = score(logits_of(model, valid, tok.pad_token_id, device)) if valid else {}
    emit("start", steps=per_epoch * args.epochs, epochs=args.epochs, trainable=sum(p.numel() for p in enc + head), valid=base_valid)
    best, best_epoch = None, 0
    t0 = time.time()
    step = 0
    for epoch in range(args.epochs):
        sigma = args.sigma[0] + (args.sigma[1] - args.sigma[0]) * (epoch / max(1, args.epochs - 1))
        losses = []
        for i, idx in enumerate(batches(train, args.batch, rnd)):
            b = collate([train[j] for j in idx], tok.pad_token_id)
            logits, act = forward(model, b, device)
            logits = logits.float()
            mask = b["marker_mask"].to(device)
            k = mask.sum(-1, keepdim=True).float()
            target = b["target"].to(device)
            # RLCD: G noisy logit vectors with zero mean over the options, rewarded by laya's proper
            # scoring rule against the target; the policy gradient pulls toward the better ones.
            eps = torch.randn((args.group,) + logits.shape, device=device) * sigma * mask
            eps = (eps - eps.sum(-1, keepdim=True) / k) * mask
            z = logits.detach().unsqueeze(0) + eps
            q = torch.softmax(z.masked_fill(~mask, -1e4), -1)
            with torch.no_grad():
                r = proper_reward(q, target.unsqueeze(0), b["qtype"].to(device), mask, w_sph=0.75, w_rps=1.0)
                adv = (r - r.mean(0, keepdim=True)) / (r.std() + 1e-6)
            logp = -(((z - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma ** 2)
            loss_rl = -(adv * logp).mean()
            loss_ce = -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)).sum(-1).mean()
            loss = (loss_rl + loss_ce) / args.accum + 0.0 * act.sum()
            loss.backward()
            losses.append(loss_ce.item())
            if (i + 1) % args.accum == 0 or i + 1 == per_epoch:
                torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
                opt.step()
                sched.step()
                opt.zero_grad(set_to_none=True)
            step += 1
            if step % 50 == 0:
                elapsed = time.time() - t0
                emit("progress", epoch=epoch + 1, step=step, steps=per_epoch * args.epochs, loss=round(sum(losses[-50:]) / len(losses[-50:]), 4),
                     seconds=round(elapsed), eta=round(elapsed / step * (per_epoch * args.epochs - step)))
        result = score(logits_of(model, valid, tok.pad_token_id, device)) if valid else {}
        emit("epoch", epoch=epoch + 1, loss=round(sum(losses) / len(losses), 4), valid=result, seconds=round(time.time() - t0))
        mean = sum(result.values()) / len(result) if result else float(epoch)
        if best is None or mean > best:
            best, best_epoch = mean, epoch + 1
            trained = dict(cfg)
            trained["training"] = {"recipe": "rlcd-mps", "epochs": epoch + 1, "items": len(train), "freeze": args.freeze, "lr_encoder": args.lr_encoder, "lr_head": args.lr_head,
                                   "batch": args.batch * args.accum, "seed": args.seed, "fine_tuned_from": cfg.get("model_name", "rl-agent"), "seconds": round(time.time() - t0)}
            trained["fine_tuned"] = True
            trained["model_name"] = "laya-realm"
            save(model, args.base, args.out, trained)
            emit("saved", epoch=epoch + 1, valid=result)

    # Temperatures, on the best epoch's weights: per option-count bucket where there are enough rows,
    # per question type otherwise, each confined to laya's range.
    if best_epoch != args.epochs:
        model.load_state_dict({k: v.float() for k, v in load_file(os.path.join(args.out, "model.safetensors")).items()}, strict=True)
    pairs = logits_of(model, calib, tok.pad_token_id, device)
    with open(os.path.join(args.out, "rl_agent_config.json")) as f:
        trained = json.load(f)
    by_type = {qt: [(it, z) for it, z in pairs if it["qtype"] == qt] for qt in range(3)}
    temperature = list(trained.get("temperature", [1.0, 1.0, 1.0]))
    for qt, sel in by_type.items():
        t = fit_temperature(sel)
        if t is not None:
            temperature[qt] = t
    buckets = {}
    for it, z in pairs:
        buckets.setdefault(temp_bucket(it["qtype"], len(z)), []).append((it, z))
    by_options = {name: t for name, sel in buckets.items() if (t := fit_temperature(sel)) is not None}
    trained["temperature"] = temperature
    trained["temperature_by_options"] = by_options
    trained["calibration"] = {"rows": len(pairs), "fitted_on": "benchmark train split", "buckets": {k: len(v) for k, v in buckets.items()}}
    with open(os.path.join(args.out, "rl_agent_config.json"), "w") as f:
        json.dump(trained, f, indent=2)
    emit("done", out=args.out, best_epoch=best_epoch, temperature=temperature, temperature_by_options=by_options, seconds=round(time.time() - t0))


if __name__ == "__main__":
    main()
