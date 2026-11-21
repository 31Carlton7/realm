import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCalendarLine } from "../src/main/meeting-watch";
import { liveEnv, noCalendarHelper, quietEnv } from "./lib/live-app.mjs";

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
});
