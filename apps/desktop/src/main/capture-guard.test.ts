import { describe, expect, it } from "vitest";
import { capturePermitted, refuseCapture } from "./capture-guard";

/**
 * The camera grant a connected iPhone's live picture needs must not become any web page's. What must
 * die: a page in a browser pane switching on this Mac's camera, and — the other way — the guard
 * refusing permissions that have nothing to do with capture (notifications, the clipboard, fullscreen).
 */
describe("refuseCapture", () => {
  it("answers no to the camera and microphone, on request and on check, and yes to everything else", () => {
    let request!: (wc: unknown, permission: string, answer: (granted: boolean) => void) => void;
    let check!: (wc: unknown, permission: string) => boolean;
    refuseCapture({ setPermissionRequestHandler: (h) => { request = h; }, setPermissionCheckHandler: (h) => { check = h; } });
    const asked = (permission: string) => { let got: boolean | null = null; request(null, permission, (g) => { got = g; }); return got; };
    // THE MUTANT: no handler at all — Electron's default approves the camera for any page.
    expect(asked("media")).toBe(false);
    expect(check(null, "media")).toBe(false);
    // THE MUTANT: refuse everything. Notifications and the clipboard stop working in every pane.
    for (const p of ["notifications", "clipboard-sanitized-write", "fullscreen", "pointerLock", "openExternal"]) {
      expect(asked(p)).toBe(true);
      expect(check(null, p)).toBe(true);
    }
    expect(capturePermitted("media")).toBe(false);
  });
});
