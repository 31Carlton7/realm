import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCalendarLine } from "../src/main/meeting-watch";
import { parseKeysLine } from "../src/main/realm-keys";
import { liveEnv, noCalendarHelper, noKeysHelper, quietEnv } from "./lib/live-app.mjs";

/**
 * Main starts `meetingwatch calendar` at launch. A live run must not read the calendar of the Mac it
 * runs on, so the launcher hands the app a stand-in unless the check names a helper of its own.
 */
describe("live runs never read the real calendar", () => {
  it("the app is given the stand-in by default", () => {
    const helper = quietEnv({}).REALM_MEETINGWATCH_BIN;
    expect(helper).toBe(noCalendarHelper());
    expect(helper).not.toMatch(/native\/bin\/meetingwatch$/);
    accessSync(helper, constants.X_OK);
  });

  it.skipIf(process.platform === "win32")("the stand-in says access was never asked for, and answers nothing after", () => {
    const run = spawnSync(noCalendarHelper(), ["calendar"], { input: "ask\ncheck\n", encoding: "utf8", timeout: 5000 });
    expect(run.status).toBe(0);
    expect(run.stdout.split("\n").filter(Boolean).map(parseCalendarLine)).toEqual([{ access: "notDetermined" }]);
  });

  it("a check's own helper wins", () => {
    expect(quietEnv({ REALM_MEETINGWATCH_BIN: "/rig/meetingwatch" }).REALM_MEETINGWATCH_BIN).toBe("/rig/meetingwatch");
    expect(liveEnv({ REALM_MEETINGWATCH_BIN: "/rig/meetingwatch" }, false).REALM_MEETINGWATCH_BIN).toBe("/rig/meetingwatch");
  });

  it("a check seen on screen keeps the stand-in", () => {
    const env = liveEnv({}, true);
    expect(env.REALM_QUIET_WINDOWS).toBeUndefined();
    expect(env.REALM_MEETINGWATCH_BIN).toBe(noCalendarHelper());
  });

  it("a check seen on screen is seen when an agent runs it, and a quiet one stays quiet", () => {
    expect(liveEnv({ REALM_AGENT_SHELL: "1" }, true).REALM_AGENT_SHELL).toBeUndefined();
    expect(liveEnv({ REALM_AGENT_SHELL: "1" }, false).REALM_AGENT_SHELL).toBe("1");
  });
});

/** Main starts `realmkeys` for the double-tap, and with `--swallow` once a chord is registered. A live
 *  run must not put a tap on the keys of whoever is at the Mac. */
describe("live runs never start the real key helper", () => {
  it("the app is given the stand-in by default, and a check's own wins", () => {
    const helper = quietEnv({}).REALM_KEYS_BIN;
    expect(helper).toBe(noKeysHelper());
    expect(helper).not.toMatch(/native\/bin\/realmkeys$/);
    accessSync(helper, constants.X_OK);
    expect(quietEnv({ REALM_KEYS_BIN: "/rig/realmkeys" }).REALM_KEYS_BIN).toBe("/rig/realmkeys");
    expect(liveEnv({}, true).REALM_KEYS_BIN).toBe(noKeysHelper());
  });

  it.skipIf(process.platform === "win32")("the stand-in says it is ready with no tap, and reports nothing after", () => {
    const run = spawnSync(noKeysHelper(), ["--swallow"], { input: `${JSON.stringify({ doubleTap: true, hold: "fn", chords: [15] })}\n`, encoding: "utf8", timeout: 5000 });
    expect(run.status).toBe(0);
    expect(run.stdout.split("\n").filter(Boolean).map(parseKeysLine)).toEqual([{ ready: true, active: false }]);
  });
});
