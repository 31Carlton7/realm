import { describe, expect, it } from "vitest";
import { childPermissionMode } from "./dispatch";

/**
 * The mode a sub-agent is born in. The user's ask: a sub-agent opens in the mode its lead is already
 * in, Full access included — the cap that used to turn a Full access lead's children into Ask-each-time
 * is what piled their permission prompts up. A request can still only tighten.
 */
describe("childPermissionMode", () => {
  it("gives a Full access lead's child Full access when nothing is requested", () => {
    // THE MUTANT: the old `parentCap → default` erasure.
    expect(childPermissionMode("bypassPermissions", undefined, "claude")).toEqual({ ok: true, mode: "bypassPermissions", capped: false, inherited: true, modeless: false });
  });

  it("holds a request above the lead to the lead's mode, and says it was capped", () => {
    // THE MUTANT: granting the request when it outranks the parent.
    expect(childPermissionMode("default", "bypassPermissions", "claude")).toEqual({ ok: true, mode: "default", capped: true, inherited: true, modeless: false });
    expect(childPermissionMode("acceptEdits", "bypassPermissions", "codex")).toMatchObject({ mode: "acceptEdits", capped: true });
  });

  it("lets a request tighten — plan under Full access is plan", () => {
    // THE MUTANT: max instead of min.
    expect(childPermissionMode("bypassPermissions", "plan", "claude")).toEqual({ ok: true, mode: "plan", capped: false, inherited: false, modeless: false });
    expect(childPermissionMode("acceptEdits", "default", "claude")).toMatchObject({ mode: "default", capped: false, inherited: false });
  });

  it("ranks ask and plan as equals — neither is capped to the other", () => {
    // THE MUTANT: ranking ask below plan, so a plan lead's ask request reads as a tightening.
    expect(childPermissionMode("plan", "ask", "claude")).toMatchObject({ mode: "plan", capped: false });
    expect(childPermissionMode("ask", "plan", "claude")).toMatchObject({ mode: "ask", capped: false });
  });

  it("refuses a read-only child on a harness Realm cannot hold to a mode, and names the ones it can", () => {
    // THE MUTANT: drop the AGENT_SUPPORTS_PERMISSION_MODES check — a plan lead mints a Cursor child
    // whose row says plan while nothing restrains it.
    const r = childPermissionMode("plan", undefined, "acp:cursor");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("Cursor");
    expect(!r.ok && r.message).toContain("Claude or Codex");
    expect(childPermissionMode("bypassPermissions", "ask", "acp:cursor").ok).toBe(false);
  });

  it("writes default for a harness Realm cannot set a mode on, rather than claim Full access", () => {
    // THE MUTANT: writing the parent's mode verbatim — the chip says Full access for a mode Realm
    // never transmitted.
    expect(childPermissionMode("bypassPermissions", undefined, "acp:cursor")).toEqual({ ok: true, mode: "default", capped: false, inherited: false, modeless: true });
  });

  it("treats a mode it does not know as default — capping fails toward asking", () => {
    expect(childPermissionMode("someAdapterMode", "acceptEdits", "claude")).toMatchObject({ mode: "someAdapterMode", capped: true });
  });
});
