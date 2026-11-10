import { describe, expect, it } from "vitest";
import { capturePermitted, guardPanePermissions, refuseCapture } from "./capture-guard";

/**
 * The camera grant a connected iPhone's live picture needs must not become any web page's. What must
 * die: a page in a browser pane switching on this Mac's camera, and — the other way — the guard
 * refusing permissions that have nothing to do with capture (notifications, the clipboard, fullscreen).
 */
describe("refuseCapture", () => {
  it("answers no to the camera, microphone and screen, on request and on check, and yes to everything else", () => {
    let request!: (wc: unknown, permission: string, answer: (granted: boolean) => void) => void;
    let check!: (wc: unknown, permission: string) => boolean;
    refuseCapture({ setPermissionRequestHandler: (h) => { request = h; }, setPermissionCheckHandler: (h) => { check = h; } });
    const asked = (permission: string) => { let got: boolean | null = null; request(null, permission, (g) => { got = g; }); return got; };
    // THE MUTANT: no handler at all — Electron's default approves the camera for any page.
    expect(asked("media")).toBe(false);
    expect(check(null, "media")).toBe(false);
    // THE MUTANT: refuse everything. Notifications and the clipboard stop working in Realm's own page.
    for (const p of ["notifications", "clipboard-sanitized-write", "fullscreen", "pointerLock", "openExternal"]) {
      expect(asked(p)).toBe(true);
      expect(check(null, p)).toBe(true);
    }
    expect(capturePermitted("media")).toBe(false);
    // THE MUTANT: refuse only `media`. Electron 45 asks for the screen as `display-capture`, which
    // Electron 37 asked as `media`, so the screen would quietly become any page's.
    expect(asked("display-capture")).toBe(false);
    expect(check(null, "display-capture")).toBe(false);
  });

  it("answers no to everything a view's frame asks for, and leaves Realm's own page as it was", () => {
    let request!: (wc: unknown, permission: string, answer: (granted: boolean) => void, details?: { requestingUrl?: string }) => void;
    let check!: (wc: unknown, permission: string, origin?: string, details?: { requestingUrl?: string }) => boolean;
    refuseCapture({ setPermissionRequestHandler: (h) => { request = h; }, setPermissionCheckHandler: (h) => { check = h; } });
    const view = "http://3f9a1c2b4d5e6f70.mcp-view.localhost:51234/v/tok";
    const asked = (permission: string, requestingUrl: string) => { let got: boolean | null = null; request(null, permission, (g) => { got = g; }, { requestingUrl }); return got; };
    // THE MUTANT: the old rule alone. A view's notification request is approved, and it can post
    // notifications as Realm (measured: the frame's request reaches this handler).
    for (const p of ["notifications", "clipboard-sanitized-write", "fullscreen", "geolocation", "media"]) {
      expect(asked(p, view), p).toBe(false);
      expect(check(null, p, "http://3f9a1c2b4d5e6f70.mcp-view.localhost:51234/"), p).toBe(false);
    }
    expect(asked("notifications", "file:///Applications/Realm.app/Contents/Resources/app/out/renderer/index.html")).toBe(true);
  });
});

describe("guardPanePermissions", () => {
  it("grants a browser pane's page fullscreen and a sanitized clipboard write, and refuses everything else", () => {
    let request!: (wc: unknown, permission: string, answer: (granted: boolean) => void, details?: { requestingUrl?: string }) => void;
    let check!: (wc: unknown, permission: string, origin?: string, details?: { requestingUrl?: string }) => boolean;
    guardPanePermissions({ setPermissionRequestHandler: (h) => { request = h; }, setPermissionCheckHandler: (h) => { check = h; } });
    const page = "https://example.com/";
    const asked = (permission: string) => { let got: boolean | null = null; request(null, permission, (g) => { got = g; }, { requestingUrl: page }); return got; };
    for (const p of ["fullscreen", "clipboard-sanitized-write"]) {
      expect(asked(p), p).toBe(true);
      expect(check(null, p, "https://example.com", { requestingUrl: page }), p).toBe(true);
    }
    // THE MUTANT: the denylist. `openExternal` hands any URL scheme to macOS with no prompt, and
    // `clipboard-read` lets a page read a copied password while the pane has focus.
    for (const p of ["openExternal", "clipboard-read", "notifications", "geolocation", "media", "display-capture", "midiSysex", "idle-detection", "window-management", "keyboardLock", "pointerLock", "storage-access", "some-new-permission"]) {
      expect(asked(p), p).toBe(false);
      expect(check(null, p, "https://example.com", { requestingUrl: page }), p).toBe(false);
    }
  });
});
