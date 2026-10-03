import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { LayaEvalReportSchema, type LayaEvalReport } from "@realm/contracts";
import { bundledLayaDir } from "./benchmark";
import { DecisionLog } from "./log";
import { LayaStepError, type LayaRuntime } from "./runtime";
import { fakeRuntime, type FakeRuntime } from "./test-fakes";
import { MIN_FREE_DISK, beats, machineState, progressOf, readEval, trainCheckpoint, type MachineState, type TrainProgress } from "./training";

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
    // And one screen recorded while its owner used an app: a training screen like any other.
    // …with half an emoji in a label, either half, as an app can give one: it reaches train.py whole or
    // not at all.
    const recorded = [{ id: "rec-1-0001", app: "Instagram", from: "recording:rec-1", elements: [{ id: "0.1", role: "Button", label: "Reels" }, { id: "0.2", role: "Button", label: "Search" }, { id: "0.3", role: "Button", label: "Profile \ud83d" }, { id: "0.4", role: "Button", label: "Saved \ude00" }] }];
    const result = await trainCheckpoint({ runtime: rt, resources, logFiles: () => log.files(), recorded: () => recorded }, { name: "2026-09-29T07-12", signal: new AbortController().signal, onProgress: (p) => progress.push(p) });

    const work = join(rt.dir, "train", "2026-09-29T07-12");
    expect(calls[0]!.script).toBe(join(resources, "train.py"));
    // Four examples a step and four steps summed: the 16 of 8 × 2, with half the memory held at once.
    expect(calls[0]!.args).toEqual(["--base", join(rt.dir, "hf", "base"), "--train", join(work, "train.jsonl"), "--calib", join(work, "calib.jsonl"), "--valid", join(work, "valid.jsonl"), "--out", join(rt.checkpointsDir, "2026-09-29T07-12"), "--batch", "4", "--accum", "4"]);
    const rows = readFileSync(join(work, "train.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { state: string; source: string });
    expect(rows.filter((r) => r.source === "log")).toHaveLength(1);
    // THE MUTANT: write rows as they come. One lone surrogate and train.py refuses the whole run.
    const strings = (x: unknown): string[] => typeof x === "string" ? [x] : Array.isArray(x) ? x.flatMap(strings) : x && typeof x === "object" ? Object.entries(x).flatMap(([k, v]) => [k, ...strings(v)]) : [];
    expect(rows.flatMap(strings).every((t) => t.match(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/) === null)).toBe(true);
    expect(rows.some((r) => JSON.stringify(r).includes("Profile \ufffd"))).toBe(true);
    // THE MUTANT: look for an emoji's first half only. Its second half, alone, is refused the same.
    expect(rows.some((r) => JSON.stringify(r).includes("Saved \ufffd"))).toBe(true);
    // THE MUTANT: never read the recordings. A person's hour in an app teaches nothing.
    expect(rows.some((r) => JSON.stringify(r).includes("Reels"))).toBe(true);
    // Held-out apps are nowhere in what it learns from.
    expect(rows.some((r) => /Grace Cathedral|Cardio Fitness|Kate Bell|Connect to Server|Wi-Fi, 3 Items/.test(r.state))).toBe(false);
    expect(progress.map((p) => p.step)).toEqual(expect.arrayContaining(["preparing", "training", "evaluating"]));
    expect(progress).toContainEqual({ step: "training", detail: "Epoch 1, step 50 of 100, about 1 min left", fraction: 0.5 });

    // The evaluation asked the server that serves the new folder, and names it the way it will be served.
    expect(rt.starts.at(-1)!.checkpoint).toBe(join(rt.checkpointsDir, "2026-09-29T07-12"));
    expect(result.report.checkpoint).toBe("local:2026-09-29T07-12");
    expect(LayaEvalReportSchema.parse(readEval(join(result.dir, "eval.json")))).toMatchObject({ checkpoint: "local:2026-09-29T07-12", benchmark: { split: "heldout" } });
    // And the server it scored through is gone: 0.8 GB of weights held for nobody otherwise.
    await expect(fetch(`http://127.0.0.1:${rt.starts.at(-1)!.port}/health`)).rejects.toThrow();
  }, 60_000);

  it("refuses to start without the download to train from", async () => {
    const rt = runtimeFor({ base: null });
    await expect(trainCheckpoint({ runtime: rt, resources, logFiles: () => [] }, { name: "n", signal: new AbortController().signal, onProgress: () => {} })).rejects.toThrow("Install Laya again");
  });

  describe("on a Mac short of memory", () => {
    const GB = 1024 ** 3;
    const go = (rt: FakeRuntime, machine: () => Promise<MachineState>, name = "n") =>
      trainCheckpoint({ runtime: rt, resources, logFiles: () => [], machine, watchMs: 5 }, { name, signal: new AbortController().signal, onProgress: () => {} });
    /** A run that goes on until it is stopped, as train.py does for half an hour. */
    const endless = (ran: string[]) => async ({ signal }: { signal?: AbortSignal }) => {
      ran.push("train");
      await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    };

    it("reads the kernel's own pressure level and the disk's free space", async () => {
      const m = await machineState(tempDir("realm-laya-machine-"));
      expect(["normal", "warn", "critical"]).toContain(m.pressure);
      expect(m.freeDiskBytes).toBeGreaterThan(0);
    });

    it("does not start while memory pressure is critical, and writes nothing", async () => {
      const ran: string[] = [];
      const rt = runtimeFor({ script: endless(ran) as never });
      // THE MUTANT: start anyway. MEASURED: a run started like this hung a 24 GB Mac 2½ minutes in.
      await expect(go(rt, async () => ({ pressure: "critical", freeDiskBytes: 100 * GB }))).rejects.toThrow(/short of memory right now/);
      expect(ran).toEqual([]);
      expect(existsSync(join(rt.dir, "train", "n"))).toBe(false);
    });

    it("does not start without room on the disk for macOS to swap, and says how much there is", async () => {
      const rt = runtimeFor({ script: endless([]) as never });
      await expect(go(rt, async () => ({ pressure: "normal", freeDiskBytes: 3 * GB }))).rejects.toThrow("needs 8.0 GB free on this disk, so macOS has room to swap while it runs, and there is 3.0 GB");
      expect(MIN_FREE_DISK).toBe(8 * GB);
    });

    it("stops a run whose pressure stays critical, before it hangs the Mac, in words that say so", async () => {
      const ran: string[] = [];
      const rt = runtimeFor({ script: endless(ran) as never });
      let reads = 0;
      // Normal as it starts, critical from then on.
      const machine = async (): Promise<MachineState> => ({ pressure: reads++ === 0 ? "normal" : "critical", freeDiskBytes: 100 * GB });
      // THE MUTANT: no watch. The run goes on into the hang it started.
      await expect(go(rt, machine)).rejects.toThrow(/ran short of memory while training, so the run was ended before it could hang/);
      expect(ran).toEqual(["train"]);
      expect(rt.starts).toHaveLength(0);
    });

    it("rides out a moment of critical pressure, and a Mac only warned", async () => {
      const ran: string[] = [];
      const rt = runtimeFor({ script: async ({ args }) => {
        ran.push("train");
        await new Promise((r) => setTimeout(r, 120));
        const out = args[args.indexOf("--out") + 1]!;
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "model.safetensors"), "weights");
      } });
      // Two critical readings, a break, and another: never three in a row. THE MUTANT that never
      // resets the count stops here.
      const readings: MachineState["pressure"][] = ["warn", "critical", "critical", "warn", "critical", "warn"];
      let reads = 0;
      // THE MUTANT: stop at the first critical reading. A spike that would pass ends half an hour of work.
      const result = await go(rt, async () => ({ pressure: readings[Math.min(reads++, readings.length - 1)]!, freeDiskBytes: 100 * GB }), "n2");
      expect(ran).toEqual(["train"]);
      expect(result.report.checkpoint).toBe("local:n2");
    }, 60_000);
  });

  it("stops at the script's failure, in the script's words, and evaluates nothing", async () => {
    const rt = runtimeFor({ script: async () => { throw new LayaStepError("train", "RuntimeError: MPS backend out of memory", ""); } });
    await expect(trainCheckpoint({ runtime: rt, resources, logFiles: () => [] }, { name: "n", signal: new AbortController().signal, onProgress: () => {} })).rejects.toThrow("MPS backend out of memory");
    expect(rt.starts).toHaveLength(0);
    expect(existsSync(join(rt.checkpointsDir, "n", "eval.json"))).toBe(false);
  });
});
