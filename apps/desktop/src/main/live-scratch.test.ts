import { describe, expect, it } from "vitest";
import { liveScratch, SCRATCH_TITLE } from "./live-scratch";

const harness = { REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "1" };
const capture = { REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "capture" };

describe("liveScratch", () => {
  it("opens a harness window hidden, unfocusable and titled as scratch", () => {
    const s = liveScratch({ packaged: false, env: harness });
    expect(s?.windowOptions).toEqual({ show: false, focusable: false, title: SCRATCH_TITLE });
    expect(s?.bannerScript).toContain("NOT YOUR REALM");
    expect(s?.toasts).toBe(true);
  });

  it("opens a capture's window unfocusable and invisible, with no banner in its pictures and no toasts", () => {
    const s = liveScratch({ packaged: false, env: capture });
    expect(s?.windowOptions).toEqual({ show: false, focusable: false, title: SCRATCH_TITLE, opacity: 0 });
    expect(s?.bannerScript).toBeNull();
    expect(s?.toasts).toBe(false);
  });

  it("is ignored by a packaged build, whatever the environment says", () => {
    expect(liveScratch({ packaged: true, env: harness })).toBeNull();
    expect(liveScratch({ packaged: true, env: capture })).toBeNull();
  });

  it("needs both the harness flag and the scratch flag", () => {
    expect(liveScratch({ packaged: false, env: { REALM_LIVE_SCRATCH: "1" } })).toBeNull();
    expect(liveScratch({ packaged: false, env: { REALM_LIVE_SCRATCH: "capture" } })).toBeNull();
    expect(liveScratch({ packaged: false, env: { REALM_ENABLE_FAKE_AGENT: "1" } })).toBeNull();
    expect(liveScratch({ packaged: false, env: { REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_SCRATCH: "yes" } })).toBeNull();
  });
});
