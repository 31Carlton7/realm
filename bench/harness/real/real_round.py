#!/usr/bin/env python3
"""Real-agent round: 3 orchestrators x 1 model x the same 3 coding tasks x N repetitions.
Orchestrators: baseline (plain git worktree, the control), orca (headless `orca serve` CLI), cs (Claude Squad TUI via tmux).
Tasks: t1 bug fix, t2 feature, t3 refactor from fixture/tasks.json, checked by the hidden verifiers in fixture/verify.
Each cell records: verified (hidden verifier), agent exit, wall time, tokens (from the CLI's own usage output),
peak RSS of orchestrator + agent processes and peak system memory (harness/sampler.py at 1 s).

usage:
  python3 harness/real/real_round.py --agent-cmd 'claude -p {prompt} --model {model} --output-format json --dangerously-skip-permissions' --model <id>
  python3 harness/real/real_round.py --dry-run      # stub agent, checks plumbing only; NOT a result
options: --tools baseline,orca,cs  --tasks t1,t2,t3  --reps 3  --timeout 900  --out runs/R-real-round
The three tasks of one repetition run in parallel inside each orchestrator; orchestrators run one after another."""
import argparse, glob, json, os, shutil, subprocess, sys, time, csv
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
H = f"{ROOT}/harness"; WRAP = f"{H}/real/agent_wrap.py"
ap = argparse.ArgumentParser()
ap.add_argument("--agent-cmd"); ap.add_argument("--model", default=""); ap.add_argument("--dry-run", action="store_true")
ap.add_argument("--tools", default="baseline,orca,cs"); ap.add_argument("--tasks", default="t1,t2,t3"); ap.add_argument("--reps", type=int, default=3)
ap.add_argument("--timeout", type=int, default=900); ap.add_argument("--out", default=None); ap.add_argument("--pat", default="claude|codex|opencode|cursor-agent|benchagent")
a = ap.parse_args()
if a.dry_run: a.agent_cmd = f"env STUB_SLEEP=6 python3 {H}/benchagent.py {{prompt}}"; a.model = "stub"
if not a.agent_cmd: sys.exit("--agent-cmd is required (or --dry-run)")
OUT = a.out or f"{ROOT}/runs/" + ("R-real-round-DRYRUN-stub" if a.dry_run else "R-real-round"); os.makedirs(OUT, exist_ok=True)
TASKS = json.load(open(f"{ROOT}/fixture/tasks.json")); names = a.tasks.split(",")
ENV = {**os.environ, "AGENT_CMD": a.agent_cmd, "AGENT_MODEL": a.model, "AGENT_TIMEOUT": str(a.timeout)}
G = ["git", "-c", "user.name=bench", "-c", "user.email=bench@localhost"]
q = lambda s: "'" + s.replace("'", "'\\''") + "'"

def fresh_repo(tag):
    d = f"/tmp/rr-{tag}"; shutil.rmtree(d, ignore_errors=True); subprocess.run(["cp", "-r", f"{ROOT}/fixture/repo", d], check=True); return d
def wait_results(paths, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout + 60:
        if all(os.path.exists(p + "/.bench/result.json") for p in paths.values()): return True
        time.sleep(1)
    return False

def run_baseline(tag):
    repo = fresh_repo(tag); paths = {}
    for n in names:
        p = f"{repo}-wt-{n}"; shutil.rmtree(p, ignore_errors=True); subprocess.run(G + ["worktree", "add", "-q", "-b", f"rr/{n}", p], cwd=repo, check=True); paths[n] = p
    t0 = time.time()
    procs = [subprocess.Popen([sys.executable, WRAP, TASKS[n]], cwd=paths[n], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for n in names]
    launch = time.time() - t0; [p.wait() for p in procs]; return paths, launch

ORCA = f"{ROOT}/tools/orca-x/squashfs-root/resources/bin/orca-ide"; OENV = {**ENV, "HOME": "/tmp/home-orca-cli", "DISPLAY": os.environ.get("DISPLAY", ":90")}
def orca(*x):
    p = subprocess.run([ORCA, *x, "--json"], env=OENV, capture_output=True, text=True)
    try: return json.loads(p.stdout)
    except Exception: return {"ok": False, "raw": (p.stdout + p.stderr)[-400:]}
def run_orca(tag):
    repo = fresh_repo(tag); rid = orca("repo", "add", "--path", repo)["result"]["repo"]["id"]; paths = {}; t0 = time.time()
    for n in names:
        wt = orca("worktree", "create", "--repo", f"id:{rid}", "--name", f"{tag}-{n}")["result"]["worktree"]; paths[n] = wt["path"]
        envs = " ".join(f"{k}={q(ENV[k])}" for k in ("AGENT_CMD", "AGENT_MODEL", "AGENT_TIMEOUT"))
        orca("terminal", "create", "--worktree", f"id:{wt['id']}", "--command", f"env {envs} python3 {WRAP} {q(TASKS[n])}")
    launch = time.time() - t0; wait_results(paths, a.timeout); return paths, launch

CS = f"{ROOT}/tools/cs/claude-squad"
def run_cs(tag):
    repo = fresh_repo(tag); subprocess.run("tmux kill-session -t rr 2>/dev/null", shell=True)
    shutil.rmtree(os.path.expanduser("~/.claude-squad/worktrees"), ignore_errors=True); subprocess.run([CS, "reset"], capture_output=True)
    envs = " ".join(f"{k}={q(ENV[k])}" for k in ("AGENT_CMD", "AGENT_MODEL", "AGENT_TIMEOUT"))
    cfg = {"default_program": "real", "auto_yes": False, "daemon_poll_interval": 1000, "branch_prefix": "rr/", "profiles": [{"name": "real", "program": f"env {envs} python3 {WRAP}"}]}
    os.makedirs(os.path.expanduser("~/.claude-squad"), exist_ok=True); json.dump(cfg, open(os.path.expanduser("~/.claude-squad/config.json"), "w"))
    tm = lambda *x: subprocess.run(["tmux", *x], check=True); cap = lambda: subprocess.run(["tmux", "capture-pane", "-t", "rr", "-p"], capture_output=True, text=True).stdout
    t0 = time.time(); tm("new-session", "-d", "-s", "rr", "-x", "200", "-y", "50", "-c", repo, CS)
    while "No agents running" not in cap() and time.time() - t0 < 30: time.sleep(.1)
    paths = {}
    for n in names:   # same keystroke protocol as harness/cs_run.py (includes ~1.1 s of driver delays per session)
        tm("send-keys", "-t", "rr", "N"); time.sleep(.4); tm("send-keys", "-t", "rr", n, "Enter"); time.sleep(.4)
        tm("send-keys", "-t", "rr", "-l", TASKS[n]); tm("send-keys", "-t", "rr", "Tab"); time.sleep(.15); tm("send-keys", "-t", "rr", "Tab"); time.sleep(.15); tm("send-keys", "-t", "rr", "Enter")
        t = time.time()
        while time.time() - t < 30 and not glob.glob(os.path.expanduser(f"~/.claude-squad/worktrees/rr/{n}_*")): time.sleep(.1)
        time.sleep(.3)
        if "Instance Created" in cap(): tm("send-keys", "-t", "rr", "Escape"); time.sleep(.3)
        w = glob.glob(os.path.expanduser(f"~/.claude-squad/worktrees/rr/{n}_*")); paths[n] = w[0] if w else None
    launch = time.time() - t0; ok = {k: v for k, v in paths.items() if v}; wait_results(ok, a.timeout)
    open(f"{OUT}/{tag}-final-screen.txt", "w").write(cap()); subprocess.run("tmux kill-session -t rr", shell=True); return paths, launch

DRV = {"baseline": run_baseline, "orca": run_orca, "cs": run_cs}
rows = []
for tool in a.tools.split(","):
    for rep in range(1, a.reps + 1):
        tag = f"{tool}-r{rep}"; res_csv = f"{OUT}/{tag}-resources.csv"
        sam = subprocess.Popen([sys.executable, f"{H}/sampler.py", res_csv, "1"], env={**os.environ, "PAT": a.pat + ("|orca" if tool == "orca" else "|claude-squad|tmux" if tool == "cs" else "")})
        T0 = time.time()
        try: paths, launch = DRV[tool](tag)
        except Exception as e: paths, launch = {}, None; print(tag, "driver error", e)
        total = round(time.time() - T0, 2); time.sleep(1.5); sam.terminate()
        res = list(csv.DictReader(open(res_csv))) if os.path.exists(res_csv) else []
        peak_rss = max((float(r["match_rss_mb"]) for r in res), default=None); peak_sys = max((float(r["sys_used_mb"]) for r in res), default=None)
        for n in names:
            p = paths.get(n); r = {}
            if p and os.path.exists(p + "/.bench/result.json"): r = json.load(open(p + "/.bench/result.json")); shutil.copy(p + "/.bench/agent.log", f"{OUT}/{tag}-{n}.agent.log")
            v = subprocess.run([sys.executable, f"{H}/verify.py", p, n], capture_output=True, text=True) if p else None
            if v: open(f"{OUT}/{tag}-{n}.verify.txt", "w").write(v.stdout + v.stderr)
            rows.append(dict(tool=tool, rep=rep, task=n, verified=bool(v and v.returncode == 0), exit=r.get("exit"), wall_s=r.get("wall_s"),
                             input_tokens=r.get("input_tokens"), output_tokens=r.get("output_tokens"), launch_all_s=round(launch, 2) if launch else None,
                             cell_wall_s=total, peak_rss_mb=peak_rss, peak_sys_used_mb=peak_sys, model=a.model, dry_run=a.dry_run))
        print(tag, [(x["task"], x["verified"], x["wall_s"]) for x in rows[-len(names):]], flush=True)
with open(f"{OUT}/results.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
json.dump({"agent_cmd": a.agent_cmd, "model": a.model, "dry_run": a.dry_run, "rows": rows}, open(f"{OUT}/results.json", "w"), indent=1)
print("wrote", OUT)
