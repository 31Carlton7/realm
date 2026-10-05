/**
 * Auto-update scaffolding (Plan 15 W1). The machinery is wired end to end — electron-updater,
 * a public GitHub feed in electron-builder.yml, the Settings→App row — and the gate below is the
 * whole story of when it may run:
 *
 *   1. Never in dev (`app.isPackaged` false). Not "usually": the updater module is not even
 *      loaded — `RealmUpdater.check()` refuses before the dynamic import.
 *   2. Never in an unsigned build. macOS's Squirrel updater validates the code signature of what
 *      it installs; an unsigned Realm.app (today's `pnpm dist` without CSC_* env) cannot apply an
 *      update, so offering a check would be a lie. `signed` is baked in at build time from the
 *      same env vars that make electron-builder sign (see electron.vite.config.ts's define).
 *   3. Never without a live public feed (`UPDATE_FEED_LIVE`). The GitHub provider reads Realm's
 *      public releases without embedding credentials in the app. Keep this explicit gate so a
 *      future hosting or visibility change fails closed instead of producing a broken updater.
 *
 * The feed is live because github.com/31Carlton7/realm is public. Builds still must be signed and
 * notarized (docs/dev/signing.md); condition 2 lifts automatically when the CSC_* build credentials
 * are present. Unsigned local iteration uses `pnpm app:update` instead of weakening this gate.
 */
export const UPDATE_FEED_LIVE = true;

export type UpdateDisabledReason = "dev" | "unsigned" | "no-feed";
export type UpdaterDecision = { enabled: true } | { enabled: false; reason: UpdateDisabledReason };

/** The gate, pure. Order is deliberate: dev is absolute, unsigned beats no-feed (signing is the
 *  harder prerequisite, and an unsigned build could not install an update even off a live feed). */
export function updaterDecision(d: { packaged: boolean; signed: boolean; feedLive: boolean }): UpdaterDecision {
  if (!d.packaged) return { enabled: false, reason: "dev" };
  if (!d.signed) return { enabled: false, reason: "unsigned" };
  if (!d.feedLive) return { enabled: false, reason: "no-feed" };
  return { enabled: true };
}

/** What the Settings row renders — every state is a fact, none is decoration. `disabled` carries
 *  the reason so the row can say WHY instead of graying out mutely; `checking` only ever appears
 *  while a real electron-updater check is in flight.
 *
 *  `available` is a newer version this build knows of and is NOT fetching — the background download
 *  failed, so a click can honestly start it again. `downloading` carries how far it has got, once
 *  electron-updater has said (`null` until its first progress event: a 0% bar would be a claim). */
export type UpdateState =
  | { kind: "disabled"; reason: UpdateDisabledReason }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };
export type UpdateStatus = { version: string; state: UpdateState };

/** The slice of electron-updater's AppUpdater this module drives; injected so tests can prove the
 *  gate (a disabled updater must never load the module at all) without Electron in the room. */
export type UpdaterLike = {
  autoDownload: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  on(event: "update-downloaded", cb: (info: { version: string }) => void): unknown;
  on(event: "download-progress", cb: (progress: { percent: number }) => void): unknown;
  on(event: "error", cb: (error: Error) => void): unknown;
  quitAndInstall(): void;
};

export class RealmUpdater {
  private state: UpdateState;
  private updater: UpdaterLike | null = null;
  constructor(private readonly d: {
    version: string;
    decision: UpdaterDecision;
    load: () => Promise<UpdaterLike>;
    onDownloaded?: (version: string) => void;
    /** Every change of state, as `status()` would answer it — what main pushes to the windows, so a
     *  download's progress reaches the rail without the renderer polling for it. */
    onChange?: (status: UpdateStatus) => void;
  }) {
    this.state = d.decision.enabled ? { kind: "idle" } : { kind: "disabled", reason: d.decision.reason };
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.d.onChange?.(this.status());
  }

  status(): UpdateStatus {
    return { version: this.d.version, state: this.state };
  }

  /** Run a real check, or answer with the disabled state unchanged. The gate lives HERE, not in the
   *  renderer: even a hand-crafted IPC call cannot start electron-updater in a gated build. */
  async check(): Promise<UpdateStatus> {
    if (!this.d.decision.enabled) return this.status();
    // A check in flight, or a download already under way or done: a second check would only start
    // electron-updater's download over again.
    if (this.state.kind === "checking" || this.state.kind === "downloading" || this.state.kind === "downloaded") return this.status();
    this.set({ kind: "checking" });
    try {
      const u = await this.ensure();
      const res = await u.checkForUpdates();
      // Only overwrite "checking": the update-downloaded event may have already advanced the state
      // while checkForUpdates' promise was settling (autoDownload runs behind it). Read through
      // `status()`, because the event's write is one the compiler cannot see from here.
      if (this.status().state.kind === "checking") {
        this.set(res?.isUpdateAvailable
          ? { kind: "downloading", version: res.updateInfo.version, percent: null }
          : { kind: "up-to-date" });
      }
    } catch (e) {
      this.set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
    return this.status();
  }

  /** Start the download again, only from `available` — the one state where a version is known and
   *  nothing is fetching it. Anything else answers its state unchanged. */
  async download(): Promise<UpdateStatus> {
    if (this.state.kind !== "available" || !this.updater) return this.status();
    const version = this.state.version;
    this.set({ kind: "downloading", version, percent: null });
    // A failure lands through the `error` event, which puts the version back to `available`; the
    // promise's own rejection says the same thing again and is not a second fact.
    await this.updater.downloadUpdate().catch(() => {});
    return this.status();
  }

  /** Quit-and-install, only from the downloaded state — never a blind relaunch. */
  install(): void {
    if (this.state.kind !== "downloaded") return;
    this.updater?.quitAndInstall();
  }

  private async ensure(): Promise<UpdaterLike> {
    if (this.updater) return this.updater;
    const u = await this.d.load();
    u.autoDownload = true;
    u.on("update-downloaded", (info) => {
      this.set({ kind: "downloaded", version: info.version });
      this.d.onDownloaded?.(info.version);
    });
    u.on("download-progress", (p) => {
      if (this.state.kind !== "downloading" || !Number.isFinite(p.percent)) return;
      this.set({ ...this.state, percent: Math.max(0, Math.min(100, p.percent)) });
    });
    /* electron-updater reports a failed download as an `error` event — with autoDownload there is no
       promise of ours to reject. A check's own failure is caught in `check` above, so this only
       answers for a download, and leaves the version known: the rail's button can start it again. */
    u.on("error", () => {
      if (this.state.kind === "downloading") this.set({ kind: "available", version: this.state.version });
    });
    this.updater = u;
    return u;
  }
}
