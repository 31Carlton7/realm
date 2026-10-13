/**
 * The Permissions tab's "Computer control" section: the two macOS grants the `realm-computer` tools
 * need, and — unlike every other row on that page — a button that can actually ask for them.
 *
 * Asking lives here rather than in `tcc.ts` because that module's governing rule is that no probe
 * may ever trigger a prompt, and the tab probes on every visit. The rows still READ their state
 * through prompt-free queries; only the request and repair paths can raise anything.
 *
 * TCC grants attach to the BUNDLE, which under `pnpm dev` is Electron rather than Realm.app — the
 * trap `mac-access.ts` documents too, and why the host name travels with the rows instead of being
 * assumed.
 *
 * Two failures shape the rest of this file (measured on the owner's Mac, 2026-10-12):
 *
 *  1. **A grant can outlive the build it was made for.** macOS stores each grant with a code
 *     requirement. Made while Realm was signed by no team, that requirement is the build's cdhash, so
 *     after an update System Settings still shows Realm switched ON while macOS refuses the new
 *     build. Nothing Realm can read tells the two apart, so the row remembers which build last held
 *     the grant: refused under a DIFFERENT build is that stale grant, and the row offers to repair it
 *     — `tccutil reset` for Realm's bundle id and that one service, then ask again. A signed Realm's
 *     grant is pinned to its designated requirement (bundle id + team) and survives updates, which is
 *     what the repair buys going forward.
 *  2. **The helper caches its answer.** The long-lived accessibility helper reads trust once and
 *     keeps it for its lifetime, so a grant flipped while it runs is invisible to it. Status is read
 *     from a FRESH helper each time, and when the answer moves, the long-lived one is stopped so the
 *     next op starts with the truth.
 */

import type { TccState } from "./tcc";

export type ComputerAccessId = "accessibility" | "screenRecording";

export type ComputerAccessRow = {
  id: ComputerAccessId;
  label: string;
  state: TccState;
  /** What this grant buys, and what still works without it — or, for a stale grant, what happened. */
  detail: string;
  /** Realm has a way to raise the real prompt for this row. */
  canPrompt: boolean;
  /** Whether the user will have to finish the job in System Settings. True whenever the grant is
   *  missing, because for both of these it is where the switch actually lives. */
  needsSettings: boolean;
  /** What the row's Allow button will really do, shown before it is pressed; null when there is
   *  nothing to ask for. Decided here rather than in the renderer because it describes what THIS
   *  process is about to call. */
  askExplanation: string | null;
  /** macOS refuses a grant this row saw held by an earlier build — System Settings likely still shows
   *  Realm switched on. Repair is then the row's main action rather than its fallback. */
  stale: boolean;
  /** Whether Repair can run here (a missing grant, and a bundle id to reset). Offered on every missing
   *  grant, because a stale grant made before Realm kept any record looks exactly like a refusal. */
  canRepair: boolean;
  /** What Repair will run, in words; null when it is not offered. */
  repairExplanation: string | null;
  /** Where the switch is on THIS macOS — the names moved (macOS 27 calls Accessibility "Device
   *  Control and Data Access", and its deep link stops at Privacy & Security). */
  settingsPlace: string;
};

export type ComputerAccessStatus = {
  rows: ComputerAccessRow[];
  /** The name macOS will show in its own lists — `macHostName`, so a dev build says "Electron". */
  hostName: string;
  /** False under `pnpm dev`: grants made now attach to Electron and will not carry into Realm.app. */
  packaged: boolean;
  /** Whether this build was signed with a Developer ID. Unsigned, every grant is pinned to this exact
   *  build and the next update loses it. */
  signed: boolean;
  /** False when this build has no compiled accessibility helper, which makes computer control
   *  unavailable no matter what macOS has granted. */
  helperAvailable: boolean;
};

export type ComputerGrantState = { accessibility: boolean; screenRecording: boolean };

/** The build that last held each grant. A grant refused under a different build is the stale one. */
export type ComputerGrantHistory = Partial<Record<ComputerAccessId, { build: string }>>;

export type ComputerRowContext = {
  helperAvailable: boolean;
  /** `process.getSystemVersion()`'s major, which decides what System Settings calls each pane. */
  macosMajor?: number;
  history?: ComputerGrantHistory;
  build?: string;
  /** Repair needs a bundle id to reset and `tccutil` to reset it with. */
  canReset?: boolean;
  hostName?: string;
};

const IDS: readonly ComputerAccessId[] = ["accessibility", "screenRecording"];

/** `tccutil`'s name for each service. A closed table: the reset can never name anything else. */
export const TCC_SERVICE: Record<ComputerAccessId, string> = { accessibility: "Accessibility", screenRecording: "ScreenCapture" };

/** Where the switch lives on a given macOS, as System Settings itself labels it (read from macOS 27's
 *  SecurityPrivacyExtension strings: ACCESSIBILITY → "Device Control and Data Access"; Sequoia renamed
 *  Screen Recording's list "Screen & System Audio Recording"). */
export function settingsPlace(id: ComputerAccessId, macosMajor = 0): string {
  const pane = id === "accessibility"
    ? (macosMajor >= 27 ? "Device Control and Data Access" : "Accessibility")
    : (macosMajor >= 15 ? "Screen & System Audio Recording" : "Screen Recording");
  return `Privacy & Security ▸ ${pane}`;
}

/** A grant refused under a different build than the one that last held it. */
export function isStaleGrant(id: ComputerAccessId, granted: boolean, history: ComputerGrantHistory, build: string): boolean {
  const held = history[id];
  return !granted && held !== undefined && held.build !== build;
}

/**
 * The history after one observation. A grant held records this build. A grant refused under the SAME
 * build that held it was switched off on purpose (or reset), so the record goes — leaving it would call
 * a deliberate refusal stale after the next update. A refusal under a different build keeps the record:
 * that is the stale grant, and it stays one until it is repaired or comes back.
 */
export function nextGrantHistory(history: ComputerGrantHistory, grants: ComputerGrantState, build: string): ComputerGrantHistory {
  const next: ComputerGrantHistory = { ...history };
  for (const id of IDS) {
    if (grants[id]) next[id] = { build };
    else if (next[id]?.build === build) delete next[id];
  }
  return next;
}

/**
 * Accessibility can always be asked for: Electron can raise that dialog whether or not the Swift
 * helper was compiled. Screen Recording cannot — the only request API for it is in the helper — so
 * without one that row offers System Settings alone rather than a button that would do nothing.
 */
export function computerAccessRows(grants: ComputerGrantState, ctx: ComputerRowContext): ComputerAccessRow[] {
  const history = ctx.history ?? {};
  const build = ctx.build ?? "";
  const host = ctx.hostName ?? "Realm";
  const row = (id: ComputerAccessId, label: string, canAsk: boolean, held: string, missing: string): ComputerAccessRow => {
    const granted = grants[id];
    const place = settingsPlace(id, ctx.macosMajor);
    const stale = isStaleGrant(id, granted, history, build);
    const canRepair = !granted && ctx.canReset === true;
    return {
      id, label,
      state: granted ? "granted" : "denied",
      detail: granted ? held
        : stale ? `System Settings may still show ${host} switched on, but macOS stopped honouring that grant when ${host} updated.`
        : missing,
      canPrompt: !granted && canAsk,
      needsSettings: !granted,
      askExplanation: !granted && canAsk ? computerGrantExplanation(id, place, host) : null,
      stale,
      canRepair,
      repairExplanation: canRepair ? computerRepairExplanation(id, place, host) : null,
      settingsPlace: place,
    };
  };
  return [
    row("accessibility", "Accessibility", true,
      "Agents you run can read other apps' windows and control them. Revoke it any time in System Settings.",
      // One line, not three. The page shows this only where the grant is missing, so it has to
      // carry the refusal and the caveat — but "Realm cannot read or drive any other app" and
      // "the computer-control tools refuse every call" were the same fact told twice.
      "Required — every computer-control call is refused without it, and macOS cannot tell “refused” from “never asked” here."),
    row("screenRecording", "Screen Recording", ctx.helperAvailable,
      "Snapshots can include a picture of the app's windows.",
      "Optional — snapshots carry no image without it. Agents act on the accessibility tree, which works either way."),
  ];
}

/**
 * Both strings promise a trip to System Settings rather than a grant, because that is what happens.
 * A button that said "Grant" and then changed nothing on screen would train the user to distrust the
 * page.
 */
export function computerGrantExplanation(id: ComputerAccessId, place = settingsPlace(id), host = "Realm"): string {
  const ask = id === "accessibility"
    ? `Asks macOS, which adds ${host} to its list`
    : "Asks macOS once (it stays silent if it has asked before)";
  return `${ask}, then opens System Settings ▸ ${place}. Switch ${host} on there; nothing is granted until you do, and this row changes on its own when you have.`;
}

export function computerRepairExplanation(id: ComputerAccessId, place = settingsPlace(id), host = "Realm"): string {
  return `For when System Settings shows ${host} switched on but this row says it is not: clears ${host}'s ${TCC_SERVICE[id]} entry (tccutil reset), asks macOS again and opens System Settings ▸ ${place}. Switch ${host} on once more.`;
}

export function isComputerAccessId(x: unknown): x is ComputerAccessId {
  return x === "accessibility" || x === "screenRecording";
}

/** A bundle id `tccutil` may be handed: reverse-DNS characters only, so nothing else reaches argv. */
export function isResettableBundleId(x: string | null): x is string {
  return typeof x === "string" && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(x);
}

export type ComputerAccessDeps = {
  helperAvailable(): boolean;
  /** Both grants, read by a process started for this read alone — never one that has been running,
   *  since the helper keeps whatever trust it saw first. */
  probe(): Promise<ComputerGrantState>;
  /** Raise macOS's own request for one grant. */
  request(id: ComputerAccessId): Promise<void>;
  /** `tccutil reset <service> <bundleId>`. */
  reset(service: string, bundleId: string): Promise<void>;
  openSettings(id: ComputerAccessId): void;
  /** Stop the long-lived helper so the next op starts one that reads trust afresh. */
  restartHelper(): void;
  loadHistory(): ComputerGrantHistory;
  saveHistory(history: ComputerGrantHistory): void;
  /** Which build this is — version and executable together, so a local rebuild counts as new. */
  build: string;
  /** The bundle id macOS keys the grants to, or null when it cannot be read. */
  bundleId(): string | null;
  macosMajor: number;
  hostName: string;
  packaged: boolean;
  signed: boolean;
};

/**
 * The section's decisions over injected legs, so the whole loop — probe, notice a change, drop the
 * cached helper, remember which build held the grant, repair — runs in a test against a scripted
 * helper. `index.ts` binds the legs to the helper, Electron and `tccutil`.
 */
export class ComputerAccess {
  private last: ComputerGrantState | null = null;
  private inFlight: Promise<ComputerAccessStatus> | null = null;

  constructor(private readonly d: ComputerAccessDeps) {}

  /** The rows as macOS answers NOW. Concurrent callers share one probe: the page polls while a
   *  switch is pending, and each probe is a process. */
  status(): Promise<ComputerAccessStatus> {
    this.inFlight ??= this.read().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** Ask macOS, then open the pane where the switch is. One click: the dialog Accessibility raises
   *  only deep-links to System Settings anyway, and Screen Recording's is silent after its first. */
  async allow(id: ComputerAccessId): Promise<ComputerAccessStatus> {
    const before = await this.status();
    const row = before.rows.find((r) => r.id === id);
    if (!row || row.state === "granted") return before;
    if (row.canPrompt) {
      try { await this.d.request(id); } catch { /* the re-read below is the real answer */ }
    }
    this.d.openSettings(id);
    return this.status();
  }

  /**
   * Clear Realm's entry for one service and ask again. Refused for a grant that works: a reset there
   * would only take away something that was fine. The helper restarts too — it is the process that
   * will be asking, and it must not carry the answer from before the reset.
   */
  async repair(id: ComputerAccessId): Promise<ComputerAccessStatus> {
    const before = await this.status();
    const row = before.rows.find((r) => r.id === id);
    if (!row || row.state === "granted" || !row.canRepair) return before;
    const bundleId = this.d.bundleId();
    if (!isResettableBundleId(bundleId)) return before;
    await this.d.reset(TCC_SERVICE[id], bundleId);
    this.d.restartHelper();
    const history = { ...this.d.loadHistory() };
    delete history[id];
    this.d.saveHistory(history);
    if (row.canPrompt) {
      try { await this.d.request(id); } catch { /* the re-read below is the real answer */ }
    }
    this.d.openSettings(id);
    return this.status();
  }

  private async read(): Promise<ComputerAccessStatus> {
    const grants = await this.d.probe();
    // The long-lived helper read trust when it started. Any change since means it is wrong now.
    if (this.last && (this.last.accessibility !== grants.accessibility || this.last.screenRecording !== grants.screenRecording)) {
      this.d.restartHelper();
    }
    this.last = grants;
    const before = this.d.loadHistory();
    const rows = computerAccessRows(grants, {
      helperAvailable: this.d.helperAvailable(),
      macosMajor: this.d.macosMajor,
      history: before,
      build: this.d.build,
      canReset: isResettableBundleId(this.d.bundleId()),
      hostName: this.d.hostName,
    });
    const after = nextGrantHistory(before, grants, this.d.build);
    if (JSON.stringify(after) !== JSON.stringify(before)) this.d.saveHistory(after);
    return { rows, hostName: this.d.hostName, packaged: this.d.packaged, signed: this.d.signed, helperAvailable: this.d.helperAvailable() };
  }
}
