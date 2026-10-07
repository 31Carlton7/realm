/**
 * A training run exactly as Settings' Train makes one (`trainCheckpoint`), against an install that
 * already exists — the dev seam, never a download:
 *
 *   REALM_LAYA_VENV=<venv with laya[serve]> REALM_LAYA_HF_HOME=<HF cache with the pinned checkpoint> \
 *     pnpm --filter @realm/server exec tsx scripts/laya/train.ts <scratch REALM_HOME> [name]
 *
 * It writes `<home>/laya/train/<name>/` (what it learned from) and `<home>/laya/checkpoints/<name>/`
 * (the weights and `eval.json`), printing the progress Settings would show. The home's recordings
 * (`<home>/laya/recordings`) are learned from, as Settings' Train learns from them.
 */
import { join } from "node:path";
import { bundledLayaDir } from "../../src/laya/benchmark";
import { DecisionLog } from "../../src/laya/log";
import { LayaRecorder } from "../../src/laya/recorder";
import { realLayaRuntime } from "../../src/laya/runtime";
import { machineState, trainCheckpoint } from "../../src/laya/training";

const home = process.argv[2];
if (!home) throw new Error("usage: train.ts <scratch REALM_HOME> [name]");
if (!process.env.REALM_LAYA_VENV || !process.env.REALM_LAYA_HF_HOME) throw new Error("set REALM_LAYA_VENV and REALM_LAYA_HF_HOME: this never installs or downloads");
const name = process.argv[3] ?? new Date().toISOString().slice(0, 16).replace(":", "-");
const runtime = realLayaRuntime({ home, env: process.env });
const log = new DecisionLog({ path: runtime.logPath });
// Read only: nothing is recorded here, so the device-facing half of the recorder is never called.
const recordings = new LayaRecorder({
  dir: join(home, "laya", "recordings"),
  read: () => Promise.reject(new Error("train.ts records nothing")), deviceName: () => "", onChange: () => {},
});
console.log(`recordings: ${recordings.list().length}, ${recordings.screens().length} screens`);
const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
const t0 = Date.now();
let last = "";
const result = await trainCheckpoint({ runtime, resources: bundledLayaDir()!, logFiles: () => log.files(), recorded: () => recordings.screens(), machine: () => machineState(runtime.dir) }, {
  name, signal: stop.signal,
  onProgress: (p) => {
    const line = `[${p.step}] ${p.detail}`;
    if (line !== last) { last = line; console.log(`${Math.round((Date.now() - t0) / 1000)}s ${line}`); }
  },
});
const r = result.report;
console.log(`${r.checkpoint}: target ${r.target.accuracy} (not copying ${r.target.notCopying?.accuracy}), assist ${JSON.stringify(r.target.assist)}, sensitive ${r.sensitive.accuracy}/${r.sensitive.recall}, verify ${r.verify.accuracy}, p50 ${r.latencyMs.p50} ms`);
console.log(`wrote ${join(result.dir, "eval.json")} in ${Math.round((Date.now() - t0) / 60000)} min`);
