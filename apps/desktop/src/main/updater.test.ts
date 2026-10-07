import { describe, expect, it } from "vitest";
import { CHECK_EVERY_MS, CHECK_ON_FOCUS_AFTER_MS, CHECK_TICK_MS, RealmUpdater, scheduleUpdateChecks, updaterDecision, UPDATE_FEED_LIVE, type UpdaterLike } from "./updater";

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
  const handlers = new Map<string, (arg: never) => void>();
  const fire = (event: string, arg: unknown) => {
    const h = handlers.get(event);
    if (!h) throw new Error(`no ${event} listener registered`);
    h(arg as never);
  };
  const u: UpdaterLike & { checks: number; downloads: number; installed: number; fireDownloaded: (v: string) => void; fireProgress: (percent: number) => void;
    fireError: (message: string) => void; nextResult: { isUpdateAvailable: boolean; updateInfo: { version: string } } | null; fail: Error | null } = {
    autoDownload: false,
    checks: 0,
    downloads: 0,
    installed: 0,
    nextResult: null,
    fail: null,
    fireDownloaded: (v) => fire("update-downloaded", { version: v }),
    fireProgress: (percent) => fire("download-progress", { percent }),
    fireError: (message) => fire("error", new Error(message)),
    checkForUpdates() {
      this.checks++;
      return this.fail ? Promise.reject(this.fail) : Promise.resolve(this.nextResult);
    },
    downloadUpdate() { this.downloads++; return Promise.resolve([]); },
    on(event: string, cb: (arg: never) => void) { handlers.set(event, cb); return this; },
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
    expect((await up.check()).state).toEqual({ kind: "downloading", version: "1.1.0", percent: null });
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

  it("reports a download's progress while it runs, clamped, and nothing once it has finished", async () => {
    const fake = fakeUpdater();
    const up = new RealmUpdater({ version: "1.0.0", decision: { enabled: true }, load: async () => fake });
    fake.nextResult = { isUpdateAvailable: true, updateInfo: { version: "1.1.0" } };
    await up.check();
    fake.fireProgress(42.5);
    expect(up.status().state).toEqual({ kind: "downloading", version: "1.1.0", percent: 42.5 });
    fake.fireProgress(140);
    expect(up.status().state).toEqual({ kind: "downloading", version: "1.1.0", percent: 100 });
    fake.fireDownloaded("1.1.0");
    // A late progress event must not drag a finished download back to "downloading".
    fake.fireProgress(99);
    expect(up.status().state).toEqual({ kind: "downloaded", version: "1.1.0" });
  });

  it("a failed download leaves the version available, and only then can a click start it again", async () => {
    const fake = fakeUpdater();
    const up = new RealmUpdater({ version: "1.0.0", decision: { enabled: true }, load: async () => fake });
    fake.nextResult = { isUpdateAvailable: true, updateInfo: { version: "1.1.0" } };
    await up.check();
    // THE MUTANT: download() honoured from `downloading` — a second fetch of the same update.
    expect((await up.download()).state).toEqual({ kind: "downloading", version: "1.1.0", percent: null });
    expect(fake.downloads).toBe(0);
    fake.fireError("net::ERR_CONNECTION_RESET");
    expect(up.status().state).toEqual({ kind: "available", version: "1.1.0" });
    expect((await up.download()).state).toEqual({ kind: "downloading", version: "1.1.0", percent: null });
    expect(fake.downloads).toBe(1);
    up.install(); // not downloaded yet
    expect(fake.installed).toBe(0);
  });

  it("a check's own failure is the check's error, not a lost download", async () => {
    const fake = fakeUpdater();
    const up = new RealmUpdater({ version: "1.0.0", decision: { enabled: true }, load: async () => fake });
    fake.checkForUpdates = function () {
      this.checks++;
      // electron-updater emits `error` AND rejects when the check itself fails.
      this.fireError("ENOTFOUND github.com");
      return Promise.reject(new Error("ENOTFOUND github.com"));
    };
    expect((await up.check()).state).toEqual({ kind: "error", message: "ENOTFOUND github.com" });
  });

  it("tells main about every change of state, so the windows hear progress without asking", async () => {
    const fake = fakeUpdater();
    const heard: string[] = [];
    const up = new RealmUpdater({
      version: "1.0.0", decision: { enabled: true }, load: async () => fake,
      onChange: (s) => heard.push(s.state.kind === "downloading" ? `downloading:${s.state.percent}` : s.state.kind),
    });
    fake.nextResult = { isUpdateAvailable: true, updateInfo: { version: "1.1.0" } };
    await up.check();
    fake.fireProgress(10);
    fake.fireDownloaded("1.1.0");
    expect(heard).toEqual(["checking", "downloading:null", "downloading:10", "downloaded"]);
  });

  it("a check during a download, or after it, does not start electron-updater over", async () => {
    const fake = fakeUpdater();
    const up = new RealmUpdater({ version: "1.0.0", decision: { enabled: true }, load: async () => fake });
    fake.nextResult = { isUpdateAvailable: true, updateInfo: { version: "1.1.0" } };
    await up.check();
    expect((await up.check()).state.kind).toBe("downloading");
    fake.fireDownloaded("1.1.0");
    expect((await up.check()).state).toEqual({ kind: "downloaded", version: "1.1.0" });
    expect(fake.checks).toBe(1);
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

describe("an open Realm keeps looking for updates", () => {
  /* It checked once, at launch, so a Realm left open never heard of a release and the rail's button
     could not appear (2.0.1, 2026-10-06). THE mutant: drop the schedule from main, or have
     checkIfStale always skip. */
  const clock = () => { let t = 1_000_000; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

  it("checks again once the last check is older than the age it is given, and not before", async () => {
    const fake = fakeUpdater(); const c = clock();
    const up = new RealmUpdater({ version: "2.0.0", decision: { enabled: true }, load: async () => fake, now: c.now });
    fake.nextResult = { isUpdateAvailable: false, updateInfo: { version: "2.0.0" } };
    await up.checkIfStale(CHECK_ON_FOCUS_AFTER_MS);      // never checked: checks
    expect(fake.checks).toBe(1);
    c.advance(CHECK_ON_FOCUS_AFTER_MS - 1);
    await up.checkIfStale(CHECK_ON_FOCUS_AFTER_MS);      // too soon
    expect(fake.checks).toBe(1);
    c.advance(1);
    fake.nextResult = { isUpdateAvailable: true, updateInfo: { version: "2.0.1" } };
    expect((await up.checkIfStale(CHECK_ON_FOCUS_AFTER_MS)).state).toEqual({ kind: "downloading", version: "2.0.1", percent: null });
    expect(fake.checks).toBe(2);
  });

  it("never stacks a check on a download, and a gated build never loads the updater", async () => {
    const fake = fakeUpdater(); const c = clock();
    const up = new RealmUpdater({ version: "2.0.0", decision: { enabled: true }, load: async () => fake, now: c.now });
    fake.nextResult = { isUpdateAvailable: true, updateInfo: { version: "2.0.1" } };
    await up.check();
    c.advance(CHECK_EVERY_MS * 2);
    await up.checkIfStale(CHECK_EVERY_MS);
    expect(fake.checks).toBe(1);
    let loads = 0;
    const gated = new RealmUpdater({ version: "2.0.0", decision: { enabled: false, reason: "unsigned" }, load: async () => { loads++; return fakeUpdater(); } });
    await gated.checkIfStale(0);
    expect(loads).toBe(0);
  });

  it("is scheduled hourly against a four-hour age, and on focus against an hour", async () => {
    const asked: number[] = [];
    let tick: () => void = () => {}, focus: () => void = () => {}, tickMs = 0;
    scheduleUpdateChecks({ checkIfStale: async (age) => { asked.push(age); } }, {
      every: (fn, ms) => { tick = fn; tickMs = ms; }, onFocus: (fn) => { focus = fn; },
    });
    expect(tickMs).toBe(CHECK_TICK_MS);
    tick(); focus();
    expect(asked).toEqual([CHECK_EVERY_MS, CHECK_ON_FOCUS_AFTER_MS]);
  });
});

describe("main schedules the checks", () => {
  it("wires the schedule to the app's updater, an interval and window focus", async () => {
    // Read as text: importing main would start an Electron app.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "index.ts"), "utf8");
    expect(src).toMatch(/scheduleUpdateChecks\(updater, \{[\s\S]*?setInterval\(fn, ms\)[\s\S]*?app\.on\("browser-window-focus", fn\)/);
  });
});
