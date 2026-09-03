import { describe, expect, it } from "vitest";
import { RealmUpdater, updaterDecision, UPDATE_FEED_LIVE, type UpdaterLike } from "./updater";

describe("updaterDecision — the hard gate (Plan 15 W1)", () => {
  it("dev is absolute: never enabled unpackaged, whatever else claims to be true", () => {
    expect(updaterDecision({ packaged: false, signed: true, feedLive: true })).toEqual({ enabled: false, reason: "dev" });
    expect(updaterDecision({ packaged: false, signed: false, feedLive: false })).toEqual({ enabled: false, reason: "dev" });
    expect(updaterDecision({ packaged: false, signed: true, feedLive: false })).toEqual({ enabled: false, reason: "dev" });
    expect(updaterDecision({ packaged: false, signed: false, feedLive: true })).toEqual({ enabled: false, reason: "dev" });
  });

  it("packaged but unsigned: disabled as 'unsigned' — and unsigned outranks no-feed, since even a live feed can't install into an unsigned app", () => {
    expect(updaterDecision({ packaged: true, signed: false, feedLive: true })).toEqual({ enabled: false, reason: "unsigned" });
    expect(updaterDecision({ packaged: true, signed: false, feedLive: false })).toEqual({ enabled: false, reason: "unsigned" });
  });

  it("packaged and signed but no public feed: disabled as 'no-feed'", () => {
    expect(updaterDecision({ packaged: true, signed: true, feedLive: false })).toEqual({ enabled: false, reason: "no-feed" });
  });

  it("enabled ONLY when packaged, signed, and the feed is live", () => {
    expect(updaterDecision({ packaged: true, signed: true, feedLive: true })).toEqual({ enabled: true });
  });

  it("the shipped public feed is live; a signed packaged build enables updates", () => {
    expect(UPDATE_FEED_LIVE).toBe(true);
    expect(updaterDecision({ packaged: true, signed: true, feedLive: UPDATE_FEED_LIVE })).toEqual({ enabled: true });
  });
});

function fakeUpdater() {
  const u: UpdaterLike & { checks: number; installed: number; fireDownloaded: (v: string) => void; nextResult: { isUpdateAvailable: boolean; updateInfo: { version: string } } | null; fail: Error | null } = {
    autoDownload: false,
    checks: 0,
    installed: 0,
    nextResult: null,
    fail: null,
    fireDownloaded: () => { throw new Error("no listener registered"); },
    checkForUpdates() {
      this.checks++;
      return this.fail ? Promise.reject(this.fail) : Promise.resolve(this.nextResult);
    },
    on(_event, cb) { this.fireDownloaded = (v) => cb({ version: v }); return this; },
    quitAndInstall() { this.installed++; },
  };
  return u;
}

describe("RealmUpdater", () => {
  it("disabled: check() answers the disabled state and NEVER loads electron-updater — the gate is in main, not the button", async () => {
    let loads = 0;
    const up = new RealmUpdater({
      version: "0.0.1",
      decision: { enabled: false, reason: "no-feed" },
      load: async () => { loads++; return fakeUpdater(); },
    });
    expect(up.status()).toEqual({ version: "0.0.1", state: { kind: "disabled", reason: "no-feed" } });
    expect(await up.check()).toEqual({ version: "0.0.1", state: { kind: "disabled", reason: "no-feed" } });
    up.install();
    expect(loads).toBe(0);
  });

  it("enabled: idle → check loads the module once, reports up-to-date honestly", async () => {
    const fake = fakeUpdater();
    let loads = 0;
    const up = new RealmUpdater({ version: "1.0.0", decision: { enabled: true }, load: async () => { loads++; return fake; } });
    expect(up.status().state).toEqual({ kind: "idle" });
    fake.nextResult = { isUpdateAvailable: false, updateInfo: { version: "1.0.0" } };
    expect((await up.check()).state).toEqual({ kind: "up-to-date" });
    await up.check();
    expect(loads).toBe(1); // ensure() caches; a second check re-uses the instance
    expect(fake.checks).toBe(2);
    expect(fake.autoDownload).toBe(true);
  });

  it("an available update reports downloading (autoDownload), then the downloaded event advances the state and install() fires", async () => {
    const fake = fakeUpdater();
    const up = new RealmUpdater({ version: "1.0.0", decision: { enabled: true }, load: async () => fake });
    fake.nextResult = { isUpdateAvailable: true, updateInfo: { version: "1.1.0" } };
    expect((await up.check()).state).toEqual({ kind: "downloading", version: "1.1.0" });
    up.install(); // not downloaded yet — must be a no-op
    expect(fake.installed).toBe(0);
    fake.fireDownloaded("1.1.0");
    expect(up.status().state).toEqual({ kind: "downloaded", version: "1.1.0" });
    up.install();
    expect(fake.installed).toBe(1);
  });

  it("notifies the host exactly when a download completes", async () => {
    const fake = fakeUpdater();
    const downloaded: string[] = [];
    const up = new RealmUpdater({
      version: "1.0.0", decision: { enabled: true }, load: async () => fake,
      onDownloaded: (version) => downloaded.push(version),
    });
    fake.nextResult = { isUpdateAvailable: true, updateInfo: { version: "1.1.0" } };
    await up.check();
    expect(downloaded).toEqual([]);
    fake.fireDownloaded("1.1.0");
    expect(downloaded).toEqual(["1.1.0"]);
  });

  it("a downloaded event that lands before checkForUpdates settles is not clobbered back to downloading", async () => {
    const fake = fakeUpdater();
    const up = new RealmUpdater({ version: "1.0.0", decision: { enabled: true }, load: async () => fake });
    fake.checkForUpdates = function () {
      this.checks++;
      // The event beats the promise — electron-updater's autoDownload can do exactly this.
      this.fireDownloaded("1.1.0");
      return Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "1.1.0" } });
    };
    expect((await up.check()).state).toEqual({ kind: "downloaded", version: "1.1.0" });
  });

  it("a failing check reports the error message, and a later check can recover", async () => {
    const fake = fakeUpdater();
    const up = new RealmUpdater({ version: "1.0.0", decision: { enabled: true }, load: async () => fake });
    fake.fail = new Error("ENOTFOUND github.com");
    expect((await up.check()).state).toEqual({ kind: "error", message: "ENOTFOUND github.com" });
    fake.fail = null;
    fake.nextResult = { isUpdateAvailable: false, updateInfo: { version: "1.0.0" } };
    expect((await up.check()).state).toEqual({ kind: "up-to-date" });
  });

  it("a check while checking does not start a second electron-updater check", async () => {
    const fake = fakeUpdater();
    const up = new RealmUpdater({ version: "1.0.0", decision: { enabled: true }, load: async () => fake });
    let settle: ((v: null) => void) | undefined;
    fake.checkForUpdates = function () { this.checks++; return new Promise((r) => { settle = r; }); };
    const first = up.check();
    expect((await up.check()).state).toEqual({ kind: "checking" });
    while (!settle) await Promise.resolve(); // the first check's async load is still resolving
    settle(null);
    expect((await first).state).toEqual({ kind: "up-to-date" });
    expect(fake.checks).toBe(1);
  });
});
