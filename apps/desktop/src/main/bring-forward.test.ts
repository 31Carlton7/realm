import { describe, expect, it } from "vitest";
import { bringForward, raiseBy } from "./bring-forward";

function rig(o: { minimized?: boolean; appActive: boolean }) {
  const calls: string[] = [];
  const win = {
    isMinimized: () => o.minimized ?? false,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
  const deps = { appActive: o.appActive, activateApp: () => calls.push("activate app") };
  return { calls, win, deps };
}

describe("bringForward", () => {
  it("brings the window and Realm in front of the app the person was in, when they asked", () => {
    const { calls, win, deps } = rig({ minimized: true, appActive: false });
    bringForward(win, "person", deps);
    expect(calls).toEqual(["restore", "show", "focus", "activate app"]);
  });

  it("leaves the window where it is while another app is in front, when an agent asked", () => {
    const { calls, win, deps } = rig({ minimized: true, appActive: false });
    bringForward(win, "agent", deps);
    expect(calls).toEqual([]);
  });

  it("raises the window inside Realm without activating it again, when an agent asked while Realm is in front", () => {
    const { calls, win, deps } = rig({ appActive: true });
    bringForward(win, "agent", deps);
    expect(calls).toEqual(["show", "focus"]);
  });
});

describe("raiseBy", () => {
  it("reads only the word agent as an agent, so a missing or odd value keeps the person's behaviour", () => {
    expect(raiseBy("agent")).toBe("agent");
    expect(raiseBy("person")).toBe("person");
    expect(raiseBy(undefined)).toBe("person");
    expect(raiseBy(null)).toBe("person");
    expect(raiseBy({ type: "click" })).toBe("person");
  });
});
