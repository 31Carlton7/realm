import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { HOLD_KEY_DEFAULT, type GlobalKeysEvent, type GlobalKeysState, type HoldKey } from "@realm/contracts";

/**
 * The keys a chord may name, as the key codes macOS gives their places on the keyboard. The helper is
 * sent codes and answers in codes; a name never crosses the pipe.
 */
export const CHORD_KEY_CODES = {
  Space: 49, ",": 43, ".": 47,
  A: 0, B: 11, C: 8, D: 2, E: 14, F: 3, G: 5, H: 4, I: 34, J: 38, K: 40, L: 37, M: 46,
  N: 45, O: 31, P: 35, Q: 12, R: 15, S: 1, T: 17, U: 32, V: 9, W: 13, X: 7, Y: 16, Z: 6,
} as const;
export type ChordKey = keyof typeof CHORD_KEY_CODES;

/** What the helper exits with when macOS lets it make no tap (RealmKeys.swift's `tapPlan`). */
const REFUSALS: Record<number, GlobalKeysState> = { 2: "denied", 3: "needsInputMonitoring" };

/** A helper that stopped unasked is started again this long after. */
export const RESTART_AFTER_MS = 1000;
/** One that stops again within this long of that start is left stopped: it cannot run. */
export const RESTART_GIVES_UP_WITHIN_MS = 10_000;

/** The double-tap's timings, as measured on Nov 20 (RealmKeys.swift states the rule they belong to). */
export const DOUBLE_TAP_MAX_HOLD_SECONDS = 0.25;
export const DOUBLE_TAP_MAX_GAP_SECONDS = 0.3;

type HelperLine = { ready: true; active: boolean } | GlobalKeysEvent | { t: "chord"; code: number };

/** One line of the helper's output (native/RealmKeys.swift), or null for one that is not. */
export function parseKeysLine(line: string): HelperLine | null {
  try {
    const v = JSON.parse(line) as { ready?: unknown; active?: unknown; t?: unknown; code?: unknown; down?: unknown };
    if (v.ready === true && typeof v.active === "boolean") return { ready: true, active: v.active };
    if (v.t === "doubleTap") return { t: "doubleTap" };
    if (v.t === "chord" && Number.isInteger(v.code)) return { t: "chord", code: v.code as number };
    if (v.t === "hold" && typeof v.down === "boolean") return { t: "hold", down: v.down };
    return null;
  } catch {
    return null;
  }
}

export type RealmKeysDeps = {
  /** Starts the helper, or null where there is none to start. `swallow` starts it able to keep a
   *  chord from the app in front (`--swallow`), which puts an active tap in the path of every key. */
  start(swallow: boolean): ChildProcessWithoutNullStreams | null;
  /** A double-tap of Command, while the setting is on. */
  onDoubleTap(): void;
  /** What a watching Settings page is shown: every double-tap, and the held key going down and up. */
  onWatched(event: GlobalKeysEvent): void;
  onState(state: GlobalKeysState): void;
};

/**
 * The keys Realm answers from any app: a double-tap of Command, and chords on a modifier held alone.
 *
 * The helper runs only while something needs it: the double-tap setting, a registered chord, or a
 * Settings page showing what the keyboard sends. With none of those it is not running, and it goes
 * when main does (it quits when its stdin closes).
 *
 * A chord is swallowed only if somebody registered it here, and nothing in the app does yet. The
 * helper is started able to swallow only while a chord is registered, and started again when the
 * first is registered or the last given back: an active tap holds every key in every app until the
 * helper answers, which is not worth paying for a double-tap alone.
 *
 * A helper macOS refused is not started again by its own exit: it would only be refused again. The
 * next change of what is needed, or `recheck`, starts it. One that stopped any other way is started
 * again once, a second later, so a crash does not end the double-tap with nothing on screen; if that
 * one stops too within ten seconds, it stays stopped.
 */
export class RealmKeys {
  private child: ChildProcessWithoutNullStreams | null = null;
  private childSwallows = false;
  private current: GlobalKeysState = "off";
  private doubleTap = false;
  private hold: HoldKey = HOLD_KEY_DEFAULT;
  private watchers = 0;
  /** When a helper was last started because the one before it stopped unasked. */
  private restartedAt: number | null = null;
  private readonly chords = new Map<number, () => void>();

  constructor(private readonly deps: RealmKeysDeps) {}

  get state(): GlobalKeysState { return this.current; }
  /** The double-tap setting, whether or not macOS lets the helper see it. */
  get doubleTapOn(): boolean { return this.doubleTap; }

  setDoubleTap(on: boolean): void { this.doubleTap = on; this.sync(); }
  setHoldKey(key: HoldKey): void { this.hold = key; this.sync(); }
  /** A Settings page started or stopped showing what the keyboard sends. */
  setWatchers(count: number): void { this.watchers = count; this.sync(); }

  /** Take `key`, pressed while the held modifier is down alone, away from the app in front and run
   *  `run` instead. Returns the way to give the key back. */
  registerChord(key: ChordKey, run: () => void): () => void {
    const code = CHORD_KEY_CODES[key];
    this.chords.set(code, run);
    this.sync();
    return () => {
      if (this.chords.get(code) !== run) return;
      this.chords.delete(code);
      this.sync();
    };
  }

  /** Start again a helper that is not swallowing: the permission may have been granted since. */
  recheck(): void {
    if (this.current === "active" || this.current === "starting") return;
    this.end();
    this.sync();
  }

  stop(): void { this.end(); this.set("off"); }

  private needed(): boolean { return this.doubleTap || this.watchers > 0 || this.chords.size > 0; }

  private sync(): void {
    if (!this.needed()) { this.stop(); return; }
    if (this.child && this.childSwallows !== this.chords.size > 0) this.end();
    if (!this.child) this.begin();
    this.child?.stdin.write(`${JSON.stringify({
      // A watching page is shown a double-tap whether or not the setting acts on it.
      doubleTap: this.doubleTap || this.watchers > 0,
      maxHold: DOUBLE_TAP_MAX_HOLD_SECONDS,
      maxGap: DOUBLE_TAP_MAX_GAP_SECONDS,
      hold: this.hold,
      chords: [...this.chords.keys()],
      reportHold: this.watchers > 0,
    })}\n`);
  }

  private begin(): void {
    let child: ChildProcessWithoutNullStreams | null = null;
    this.childSwallows = this.chords.size > 0;
    try { child = this.deps.start(this.childSwallows); } catch (e) { console.warn("[realmkeys] failed to spawn:", (e as Error).message); }
    if (!child) { this.set("missing"); return; }
    this.child = child;
    this.set("starting");
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      if (this.child !== child) return;
      buf += d.toString();
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const line = parseKeysLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (line) this.heard(line);
      }
    });
    child.stderr.on("data", (d: Buffer) => { const s = d.toString().trim(); if (s) console.warn("[realmkeys]", s); });
    // The pipe of a helper that has gone: its exit says what happened.
    child.stdin.on("error", () => {});
    // A spawn that fails reports here, after `start` has returned; unheard, it is an uncaught
    // exception and main stops behind its crash dialog.
    child.on("error", (e) => {
      console.warn("[realmkeys] failed to spawn:", e.message);
      if (this.child === child) { this.child = null; this.set("missing"); }
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      const refusal = code === null ? undefined : REFUSALS[code];
      if (refusal) { this.set(refusal); return; }
      this.set("missing");
      if (this.restartedAt !== null && Date.now() - this.restartedAt < RESTART_GIVES_UP_WITHIN_MS) return;
      setTimeout(() => {
        // Something started one since, or nothing needs one any more.
        if (this.child || !this.needed()) return;
        this.restartedAt = Date.now();
        this.sync();
      }, RESTART_AFTER_MS);
    });
  }

  private heard(line: HelperLine): void {
    if ("ready" in line) { this.set(line.active ? "active" : "listening"); return; }
    if (line.t === "chord") { this.chords.get(line.code)?.(); return; }
    if (this.watchers > 0) this.deps.onWatched(line);
    if (line.t === "doubleTap" && this.doubleTap) this.deps.onDoubleTap();
  }

  private end(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    try { child.stdin.end(); child.kill(); } catch { /* already gone */ }
  }

  private set(state: GlobalKeysState): void {
    if (state === this.current) return;
    this.current = state;
    this.deps.onState(state);
  }
}
