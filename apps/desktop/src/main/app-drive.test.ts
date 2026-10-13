import { describe, expect, it } from "vitest";
import type { BrowserAction } from "@realm/contracts";
import { AppDriveHost, PICKING_REFUSAL } from "./app-drive";

const CLICK: BrowserAction = { kind: "click", ref: 4, button: "left", clickCount: 1, modifiers: [] };
const SCROLL: BrowserAction = { kind: "scroll", deltaX: 0, deltaY: 40 };

/**
 * The app drive standing down while the person picks a part of the window (app-pick.ts). Everything
 * else about the drive is `buildSnapshot` / `performAct`, whose own suites hold them; this is the one
 * rule that is the host's.
 */
describe("AppDriveHost while the person is picking", () => {
  const host = (picking: boolean) => {
    const sent: string[] = [];
    const drive = new AppDriveHost({
      picking: () => picking,
      attach: () => ({ send: async (method: string) => { sent.push(method); return {}; } }),
    });
    return { drive, sent };
  };

  it("refuses every act, before it reaches the window, so an agent's click can never land as the pick", async () => {
    // THE MUTANT: drop the check. The picker takes the next click in the window as the person's, and
    // an agent's `app_act` click is a click in the window.
    const { drive, sent } = host(true);
    for (const action of [CLICK, { kind: "key", key: "Enter" } as BrowserAction, SCROLL]) {
      expect(await drive.act(action)).toEqual({ ok: false, error: PICKING_REFUSAL });
    }
    expect(sent).toEqual([]);
  });

  it("says it is a moment's wait rather than a protected surface, so the agent tries again after", async () => {
    const { drive } = host(true);
    const r = await drive.act(CLICK);
    expect(r.ok === false && r.refused).toBeUndefined();
    expect(PICKING_REFUSAL).toContain("try again in a moment");
  });

  it("acts as ever when nobody is picking", async () => {
    const { drive, sent } = host(false);
    await drive.act(SCROLL);
    expect(sent.length).toBeGreaterThan(0);
  });
});

describe("AppDriveHost and a key with no ref", () => {
  const host = (focusedIn: string | null) => {
    const sent: string[] = [];
    const drive = new AppDriveHost({
      attach: () => ({ send: async (method: string) => {
        sent.push(method);
        return method === "Runtime.evaluate" ? { result: { value: focusedIn } } : {};
      } }),
    });
    return { drive, sent };
  };

  it("refuses Return while focus is inside a protected surface — Tab, Tab, Return cannot press a post sheet's button", async () => {
    // THE MUTANT: check only refs. A ref-less key lands on the focused element, so an agent tabs onto
    // "Post at 4:10 PM" and presses Return without ever naming the button.
    const { drive, sent } = host("post sheet");
    const r = await drive.act({ kind: "key", key: "Enter" } as BrowserAction);
    expect(r).toMatchObject({ ok: false, refused: "realm_protected" });
    expect(r.ok === false && r.error).toContain("post sheet");
    expect(sent).toEqual(["Runtime.evaluate"]);
  });

  it("presses the key when focus is anywhere else", async () => {
    const { drive, sent } = host(null);
    await drive.act({ kind: "key", key: "Enter" } as BrowserAction);
    expect(sent.length).toBeGreaterThan(1);
  });
});
