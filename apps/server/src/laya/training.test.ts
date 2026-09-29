import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { LayaEvalReportSchema, type LayaEvalReport } from "@realm/contracts";
import { bundledLayaDir } from "./benchmark";
import { DecisionLog } from "./log";
import { LayaStepError, type LayaRuntime } from "./runtime";
import { fakeRuntime, type FakeRuntime } from "./test-fakes";
import { beats, progressOf, readEval, trainCheckpoint, type TrainProgress } from "./training";

/**
 * A training run end to end, with the script and laya-serve both stood in for: the rows it writes,
 * the script it runs and how, the progress it reads back, and the evaluation of what it wrote,
 * through the same server wire as any other. What must die: a run that trains on a held-out app,
 * reads the wrong progress, or writes a report of anything but the checkpoint it trained.
 */

const resources = bundledLayaDir()!;
const runtimes: FakeRuntime[] = [];
afterEach(async () => { for (const r of runtimes.splice(0)) await r.server()?.close(); });

function report(over: { accuracy?: number; version?: string } = {}): LayaEvalReport {
  return {
    v: 1, checkpoint: "c", createdAt: "2026-09-29T00:00:00Z", prompt: 2,
    benchmark: { version: over.version ?? "b", split: "heldout", cases: 1, apps: [] },
    target: { accuracy: over.accuracy ?? 0.5, n: 1, byApp: {}, assist: { threshold: null, precision: 0, coverage: 0 } },
    sensitive: { accuracy: 0, recall: 0, precision: 0, n: 0 }, verify: { accuracy: 0, n: 0 },
    baseline: { sensitiveRule: { accuracy: 0, recall: 0 }, verifyRule: { accuracy: 0 } }, latencyMs: { p50: 0, p90: 0 },
  };
}

describe("whether a new checkpoint replaces the active one", () => {
  it("does when it picks the right element more often on held-out steps, and only then", () => {
    expect(beats(report({ accuracy: 0.61 }), report({ accuracy: 0.6 })).yes).toBe(true);
    // THE MUTANT: >= — a tie would swap the weights under a log for nothing.
    expect(beats(report({ accuracy: 0.6 }), report({ accuracy: 0.6 })).yes).toBe(false);
    expect(beats(report({ accuracy: 0.5 }), report({ accuracy: 0.6 }))).toEqual({ yes: false, reason: "It picks the right element 50% of the time on held-out steps, and the active checkpoint 60%." });
  });

  it("does when the active one has no evaluation, or one on another benchmark", () => {
    expect(beats(report({ accuracy: 0.1 }), null)).toEqual({ yes: true, reason: "It picks the right element 10% of the time on held-out steps, and the active checkpoint has no evaluation." });
    expect(beats(report({ accuracy: 0.1, version: "b2" }), report({ accuracy: 0.9, version: "b1" })).yes).toBe(true);
  });
});

describe("the script's progress", () => {
  it("reads its progress lines, and nothing else", () => {
    expect(progressOf(JSON.stringify({ event: "progress", epoch: 1, step: 300, steps: 1200, loss: 0.5, eta: 1500 }))).toEqual({ step: "training", detail: "Epoch 1, step 300 of 1200, about 25 min left", fraction: 0.25 });
    expect(progressOf(JSON.stringify({ event: "done" }))).toEqual({ step: "training", detail: "Fitting its confidence", fraction: 1 });
    expect(progressOf(JSON.stringify({ event: "epoch", epoch: 1 }))).toBeNull();
    expect(progressOf("Warning: something torch said")).toBeNull();
    expect(progressOf(JSON.stringify({ event: "progress", step: 3, steps: 0 }))).toBeNull();
  });
});

describe("a training run", () => {
  function runtimeFor(o: { base?: string | null; script?: LayaRuntime["runScript"] } = {}): FakeRuntime {
    const dir = tempDir("realm-laya-train-");
    const rt = fakeRuntime({ dir, installed: true, base: o.base === undefined ? join(dir, "hf", "base") : o.base, runScript: o.script, server: { choose: (criteria) => Object.keys(criteria)[0]!, noul: () => 0.9 } });
    runtimes.push(rt);
    return rt;
  }

  it("writes what it learns from, runs train.py on it in the venv, and scores what it wrote as local:<name>", async () => {
    const calls: { script: string; args: string[] }[] = [];
    const rt = runtimeFor({ script: async ({ script, args, onLine }) => {
      calls.push({ script, args });
      onLine(JSON.stringify({ event: "progress", epoch: 1, step: 50, steps: 100, eta: 60 }));
      onLine("a line that is not progress");
      const out = args[args.indexOf("--out") + 1]!;
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "model.safetensors"), "weights");
    } });
    // One step the user's agent took: it is trained on, as the agent chose it.
    const log = new DecisionLog({ path: join(rt.dir, "decisions.jsonl") });
    log.append({ v: 1, intent: "open Wi-Fi", tool: "simulator_tap", candidates: [{ id: "1", role: "Button", label: "Wi-Fi" }, { id: "2", role: "Button", label: "General" }], truth: { target: { id: "1", source: "agent" }, verify: null }, laya: { verify: null } });
    const progress: TrainProgress[] = [];
    const result = await trainCheckpoint({ runtime: rt, resources, logFiles: () => log.files() }, { name: "2026-09-29T07-12", signal: new AbortController().signal, onProgress: (p) => progress.push(p) });

    const work = join(rt.dir, "train", "2026-09-29T07-12");
    expect(calls[0]!.script).toBe(join(resources, "train.py"));
    expect(calls[0]!.args).toEqual(["--base", join(rt.dir, "hf", "base"), "--train", join(work, "train.jsonl"), "--calib", join(work, "calib.jsonl"), "--valid", join(work, "valid.jsonl"), "--out", join(rt.checkpointsDir, "2026-09-29T07-12")]);
    const rows = readFileSync(join(work, "train.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { state: string; source: string });
    expect(rows.filter((r) => r.source === "log")).toHaveLength(1);
    // Held-out apps are nowhere in what it learns from.
    expect(rows.some((r) => /Grace Cathedral|Cardio Fitness|Kate Bell|Connect to Server|Wi-Fi, 3 Items/.test(r.state))).toBe(false);
    expect(progress.map((p) => p.step)).toEqual(expect.arrayContaining(["preparing", "training", "evaluating"]));
    expect(progress).toContainEqual({ step: "training", detail: "Epoch 1, step 50 of 100, about 1 min left", fraction: 0.5 });

    // The evaluation asked the server that serves the new folder, and names it the way it will be served.
    expect(rt.starts.at(-1)!.checkpoint).toBe(join(rt.checkpointsDir, "2026-09-29T07-12"));
    expect(result.report.checkpoint).toBe("local:2026-09-29T07-12");
    expect(LayaEvalReportSchema.parse(readEval(join(result.dir, "eval.json")))).toMatchObject({ checkpoint: "local:2026-09-29T07-12", benchmark: { split: "heldout" } });
  }, 60_000);

  it("refuses to start without the download to train from", async () => {
    const rt = runtimeFor({ base: null });
    await expect(trainCheckpoint({ runtime: rt, resources, logFiles: () => [] }, { name: "n", signal: new AbortController().signal, onProgress: () => {} })).rejects.toThrow("Install Laya again");
  });

  it("stops at the script's failure, in the script's words, and evaluates nothing", async () => {
    const rt = runtimeFor({ script: async () => { throw new LayaStepError("train", "RuntimeError: MPS backend out of memory", ""); } });
    await expect(trainCheckpoint({ runtime: rt, resources, logFiles: () => [] }, { name: "n", signal: new AbortController().signal, onProgress: () => {} })).rejects.toThrow("MPS backend out of memory");
    expect(rt.starts).toHaveLength(0);
    expect(existsSync(join(rt.checkpointsDir, "n", "eval.json"))).toBe(false);
  });
});
