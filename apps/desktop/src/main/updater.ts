/**
 * Auto-update scaffolding (Plan 15 W1). The machinery is wired end to end — electron-updater,
 * a feed config in electron-builder.yml, the Settings→App row — but it ships DISABLED, and the
 * gate below is the whole story of when it may run:
 *
 *   1. Never in dev (`app.isPackaged` false). Not "usually": the updater module is not even
 *      loaded — `RealmUpdater.check()` refuses before the dynamic import.
 *   2. Never in an unsigned build. macOS's Squirrel updater validates the code signature of what
 *      it installs; an unsigned Realm.app (today's `pnpm dist` without CSC_* env) cannot apply an
 *      update, so offering a check would be a lie. `signed` is baked in at build time from the
 *      same env vars that make electron-builder sign (see electron.vite.config.ts's define).
 *   3. Never without a live public feed (`UPDATE_FEED_LIVE`). The repo is PRIVATE: electron-updater's
 *      GitHub provider can only reach private release assets with an API token, and shipping a
 *      GitHub token inside a desktop app hands write-scoped credentials to every user who unzips
 *      the asar — banned, permanently. So the feed config in electron-builder.yml points at this
 *      repo's releases for the day they are PUBLIC, and until then the flag stays false.
 *
 * ACTIVATION CONDITIONS — flip `UPDATE_FEED_LIVE` to true only when BOTH hold:
 *   a. Releases are reachable without credentials: the repo (or a mirror the publish config points
 *      at) has public releases carrying the dmg/zip + latest-mac.yml that `pnpm release` builds,
 *      OR a generic update server (any static host serving those same files) replaces the GitHub
 *      provider in electron-builder.yml.
 *   b. Builds are signed + notarized (docs/dev/signing.md) — condition 2 lifts on its own then.
 * Nothing else changes: the gate reads the flag, the Settings row starts offering a real check,
 * and quit-and-install already tears the server child down via before-quit-for-update (index.ts).
 */
export const UPDATE_FEED_LIVE = false;

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
 *  while a real electron-updater check is in flight. */
export type UpdateState =
  | { kind: "disabled"; reason: UpdateDisabledReason }
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "downloading"; version: string }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };
export type UpdateStatus = { version: string; state: UpdateState };

/** The slice of electron-updater's AppUpdater this module drives; injected so tests can prove the
 *  gate (a disabled updater must never load the module at all) without Electron in the room. */
export type UpdaterLike = {
  autoDownload: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>;
  on(event: "update-downloaded", cb: (info: { version: string }) => void): unknown;
  quitAndInstall(): void;
};

export class RealmUpdater {
  private state: UpdateState;
  private updater: UpdaterLike | null = null;
  constructor(private readonly d: { version: string; decision: UpdaterDecision; load: () => Promise<UpdaterLike> }) {
    this.state = d.decision.enabled ? { kind: "idle" } : { kind: "disabled", reason: d.decision.reason };
  }

  status(): UpdateStatus {
    return { version: this.d.version, state: this.state };
  }

  /** Run a real check, or answer with the disabled state unchanged. The gate lives HERE, not in the
   *  renderer: even a hand-crafted IPC call cannot start electron-updater in a gated build. */
  async check(): Promise<UpdateStatus> {
    if (!this.d.decision.enabled) return this.status();
    if (this.state.kind === "checking") return this.status();
    this.state = { kind: "checking" };
    try {
      const u = await this.ensure();
      const res = await u.checkForUpdates();
      // Only overwrite "checking": the update-downloaded event may have already advanced the state
      // while checkForUpdates' promise was settling (autoDownload runs behind it).
      if (this.state.kind === "checking") {
        this.state = res?.isUpdateAvailable
          ? { kind: "downloading", version: res.updateInfo.version }
          : { kind: "up-to-date" };
      }
    } catch (e) {
      this.state = { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }
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
    u.on("update-downloaded", (info) => { this.state = { kind: "downloaded", version: info.version }; });
    this.updater = u;
    return u;
  }
}
