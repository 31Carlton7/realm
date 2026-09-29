import { z } from "zod";

/**
 * Laya — Convai's open-weight decision model, run by Realm on this Mac beside every computer and
 * device step (docs/superpowers/specs/2026-09-29-laya-local-decisions.md).
 *
 * Three positions. `shadow` asks Laya on every step and logs its answer next to what actually
 * happened; nothing it says reaches the agent, a permission card or the transcript. `assist` is
 * shadow plus one thing: an agent may describe the element to act on instead of numbering it, and
 * Laya's pick is used — but only when the ACTIVE checkpoint's held-out evaluation clears the bar
 * (`LAYA_ASSIST_MIN_ACCURACY`), only above the confidence fitted for high precision, and never on a
 * step the sensitive rule flags. Everything else goes back to the agent as numbered candidates.
 */
export const LAYA_MODES = ["off", "shadow", "assist"] as const;
export const LayaModeSchema = z.enum(LAYA_MODES);
export type LayaMode = z.infer<typeof LayaModeSchema>;

/** The three parts of an install, in order: a venv, `laya[serve]` and PyTorch into it, then the
 *  checkpoint. Named so the one line Settings shows can say which of three very different waits
 *  this is. */
export const LayaInstallStepSchema = z.enum(["environment", "packages", "model"]);
export type LayaInstallStep = z.infer<typeof LayaInstallStepSchema>;

/**
 * Where the local runtime stands — what Settings writes as its one state line.
 *
 * `unavailable` is a build or a machine that cannot run Laya at all (a test app built without the
 * runtime, an Intel Mac). `needs-python` means Realm looked and found no interpreter it can use, and
 * lists the ones it turned down with the reason; it never guesses one. `failed` carries the reason
 * the process or the installer gave, verbatim, and says which of the two it was.
 */
export const LayaRuntimeStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unavailable"), reason: z.string() }),
  z.object({ state: z.literal("needs-python"), rejected: z.array(z.object({ path: z.string(), why: z.string() })) }),
  z.object({ state: z.literal("not-installed"), python: z.object({ path: z.string(), version: z.string() }) }),
  z.object({
    state: z.literal("installing"), step: LayaInstallStepSchema, detail: z.string(),
    /** Only the checkpoint download has a real denominator; the other steps are null, not a guess. */
    fraction: z.number().min(0).max(1).nullable(),
  }),
  z.object({ state: z.literal("off") }),
  z.object({ state: z.literal("starting") }),
  z.object({
    state: z.literal("ready"),
    /** Where the checkpoint actually computes, as laya-serve reports it — `mps` or, after a silent
     *  fallback, `cpu`. Not what was asked for. */
    device: z.string(),
    /** Median round trip of the recent questions, in milliseconds; null before the first. */
    p50Ms: z.number().nullable(),
    /** e.g. `english@55cf4c4` — the checkpoint every logged row names. */
    checkpoint: z.string(),
  }),
  z.object({ state: z.literal("failed"), during: z.enum(["install", "start"]), reason: z.string(), detail: z.string() }),
]);
export type LayaRuntimeState = z.infer<typeof LayaRuntimeStateSchema>;

/** The held-out accuracy a checkpoint needs on `target` before Assist may act on its picks. */
export const LAYA_ASSIST_MIN_ACCURACY = 0.95;

/**
 * A checkpoint's evaluation, written beside it as `eval.json` by the eval harness (the shared
 * contract in docs/superpowers/specs/2026-09-29-laya-local-decisions.md). Settings shows it and the
 * Assist gate reads it; fields may be added, never renamed or retyped.
 */
export const LayaEvalReportSchema = z.object({
  v: z.literal(1),
  checkpoint: z.string(),
  createdAt: z.string(),
  prompt: z.number().int(),
  benchmark: z.object({ version: z.string(), split: z.literal("heldout"), cases: z.number().int(), apps: z.array(z.string()) }),
  target: z.object({
    accuracy: z.number().min(0).max(1),
    n: z.number().int(),
    byApp: z.record(z.object({ accuracy: z.number(), n: z.number().int() })),
    /** The confidence at or above which the top pick was right at least `precision` of the time on
     *  held-out steps; null when none reached it. */
    assist: z.object({ threshold: z.number().nullable(), precision: z.number(), coverage: z.number() }),
  }),
  sensitive: z.object({ accuracy: z.number(), recall: z.number(), precision: z.number(), n: z.number().int() }),
  verify: z.object({ accuracy: z.number(), n: z.number().int() }),
  baseline: z.object({ sensitiveRule: z.object({ accuracy: z.number(), recall: z.number() }), verifyRule: z.object({ accuracy: z.number() }) }),
  latencyMs: z.object({ p50: z.number(), p90: z.number() }),
}).passthrough();
export type LayaEvalReport = z.infer<typeof LayaEvalReportSchema>;

/** Whether Assist may act, and in words why not — the reason Settings shows beside a locked option. */
export const LayaAssistGateSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  /** The confidence Laya's pick must reach to be used; null while locked. */
  threshold: z.number().nullable(),
  /** The active checkpoint's held-out `target` accuracy, when there is an evaluation at all. */
  accuracy: z.number().nullable(),
});
export type LayaAssistGate = z.infer<typeof LayaAssistGateSchema>;

export const LayaStatusSchema = z.object({
  mode: LayaModeSchema,
  /** A finished install is on disk. The mode can only be switched to `shadow` once it is. */
  installed: z.boolean(),
  runtime: LayaRuntimeStateSchema,
  /** Rows in the decision log, across its rotated files. */
  stepsLogged: z.number().int().nonnegative(),
  /** `<REALM_HOME>/laya`: the runtime, the checkpoint and the log all live under it. */
  dir: z.string(),
  assist: LayaAssistGateSchema,
});
export type LayaStatus = z.infer<typeof LayaStatusSchema>;
