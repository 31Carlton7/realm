import { z } from "zod";

/**
 * Laya — Convai's open-weight decision model, run by Realm on this Mac beside every computer and
 * device step (docs/superpowers/specs/2026-09-29-laya-local-decisions.md).
 *
 * Two positions, and no third yet. `shadow` asks Laya on every step and logs its answer next to what
 * actually happened; nothing it says reaches the agent, a permission card or the transcript. An
 * `assist` position waits on Phase 2: a checkpoint trained on this Mac's own log has to clear a
 * measured bar before Laya may decide anything.
 */
export const LAYA_MODES = ["off", "shadow"] as const;
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

export const LayaStatusSchema = z.object({
  mode: LayaModeSchema,
  /** A finished install is on disk. The mode can only be switched to `shadow` once it is. */
  installed: z.boolean(),
  runtime: LayaRuntimeStateSchema,
  /** Rows in the decision log, across its rotated files. */
  stepsLogged: z.number().int().nonnegative(),
  /** `<REALM_HOME>/laya`: the runtime, the checkpoint and the log all live under it. */
  dir: z.string(),
});
export type LayaStatus = z.infer<typeof LayaStatusSchema>;
