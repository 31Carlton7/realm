import { describe, expect, it } from "vitest";
import { ACT_PACING } from "./team-acts";
import {
  CLASS_FLOORS, autoCeiling, bindsEverySession, canonicalJson, policyRowProblem, policySealText, resolvePolicy, toolScopeKey,
  type PolicyCall, type TeamPolicyRow,
} from "./team-policy";

const row = (o: Partial<TeamPolicyRow> & Pick<TeamPolicyRow, "scope" | "scopeKey" | "decision">): TeamPolicyRow => ({
  id: `${o.scope}:${o.scopeKey}`, spaceId: "S", caps: {}, checks: [], setBy: "user", sealed: false, createdAt: 1, updatedAt: 1, ...o,
});

const send: PolicyCall = { connector: "mcp:GMAIL", tool: "send_message", class: "irreversible-external", verb: "send" };
const save: PolicyCall = { connector: "mcp:LINEAR", tool: "save_issue", class: "reversible-external", verb: "save" };

describe("the floors", () => {
  it("read and change this space go ahead; anything elsewhere asks", () => {
    expect(CLASS_FLOORS).toEqual({ read: "auto", "internal-write": "auto", "reversible-external": "ask", "irreversible-external": "ask" });
    expect(resolvePolicy([], send)).toMatchObject({ decision: "ask", row: null, unconfirmed: null });
    // A Realm read that asks first in both engines keeps asking.
    expect(resolvePolicy([], { connector: "realm:realm-terminal", tool: "terminal_read", class: "read", verb: "read", asksFirst: true }).decision).toBe("ask");
  });
});

describe("resolvePolicy", () => {
  it("lets any row tighten, from the class down to the tool", () => {
    expect(resolvePolicy([row({ scope: "class", scopeKey: "irreversible-external", decision: "block" })], send).decision).toBe("block");
    expect(resolvePolicy([row({ scope: "verb", scopeKey: "send", decision: "ticket" })], send).decision).toBe("ticket");
    expect(resolvePolicy([row({ scope: "connector", scopeKey: "mcp:GMAIL", decision: "block" })], send).decision).toBe("block");
    expect(resolvePolicy([row({ scope: "tool", scopeKey: toolScopeKey("mcp:GMAIL", "send_message"), decision: "block" })], send).decision).toBe("block");
  });

  it("sets an unsealed loosening aside and says so — a row written with sqlite3 gains nothing", () => {
    // THE MUTANT: honouring an unsealed row looser than what stands.
    const forged = row({ scope: "tool", scopeKey: toolScopeKey("mcp:GMAIL", "send_message"), decision: "auto", caps: { perDay: 5 } });
    expect(resolvePolicy([forged], send)).toMatchObject({ decision: "ask", row: null, unconfirmed: forged });
    // …and an unsealed "ask" under a class the person set to never does not reopen it.
    const never = row({ scope: "class", scopeKey: "irreversible-external", decision: "block" });
    expect(resolvePolicy([never, row({ scope: "tool", scopeKey: toolScopeKey("mcp:GMAIL", "send_message"), decision: "ask" })], send).decision).toBe("block");
  });

  it("honours a sealed row for one tool, exactly as pressed, even under a tighter class", () => {
    const sealed = row({ scope: "tool", scopeKey: toolScopeKey("mcp:GMAIL", "send_message"), decision: "auto", caps: { perDay: 5 }, sealed: true });
    expect(resolvePolicy([row({ scope: "class", scopeKey: "irreversible-external", decision: "block" }), sealed], send)).toMatchObject({ decision: "auto", row: sealed });
  });

  it("reads a sealed row a rule forbids as unsealed: no cap, a cap past the ceiling, or a whole class", () => {
    const tool = toolScopeKey("mcp:GMAIL", "send_message");
    // THE MUTANTS: the cap made optional, the ceiling check dropped, a class-wide no-click honoured.
    expect(resolvePolicy([row({ scope: "tool", scopeKey: tool, decision: "auto", sealed: true })], send).decision).toBe("ask");
    expect(resolvePolicy([row({ scope: "tool", scopeKey: tool, decision: "auto", caps: { perDay: 21 }, sealed: true })], send).decision).toBe("ask");
    expect(resolvePolicy([row({ scope: "class", scopeKey: "irreversible-external", decision: "auto", caps: { perDay: 3 }, sealed: true })], send).decision).toBe("ask");
    expect(resolvePolicy([row({ scope: "verb", scopeKey: "send", decision: "auto", caps: { perDay: 3 }, sealed: true })], send).decision).toBe("ask");
    // A post's ceiling is today's posts; a message's is today's DMs.
    const post: PolicyCall = { connector: "mcp:X", tool: "post_thing", class: "irreversible-external", verb: "post" };
    expect(resolvePolicy([row({ scope: "tool", scopeKey: toolScopeKey("mcp:X", "post_thing"), decision: "auto", caps: { perDay: 4 }, sealed: true })], post).decision).toBe("ask");
    expect(resolvePolicy([row({ scope: "tool", scopeKey: toolScopeKey("mcp:X", "post_thing"), decision: "auto", caps: { perDay: 3 }, sealed: true })], post).decision).toBe("auto");
  });

  it("lets a whole class of undoable changes go without asking, sealed and capped", () => {
    const r = row({ scope: "class", scopeKey: "reversible-external", decision: "auto", caps: { perDay: 20 }, sealed: true });
    expect(resolvePolicy([r], save).decision).toBe("auto");
    expect(resolvePolicy([{ ...r, sealed: false }], save).decision).toBe("ask");
  });
});

describe("policyRowProblem", () => {
  const cover = (classes: PolicyCall["class"][], verbs: string[] = []) => ({ classes, irreversibleVerbs: verbs });
  it("refuses no-click on a whole kind of action that can't be taken back", () => {
    expect(policyRowProblem({ scope: "class", scopeKey: "irreversible-external", decision: "auto", caps: { perDay: 1 }, checks: [] }, cover(["irreversible-external"], ["send"]))).toMatch(/one connection or one tool/);
  });
  it("needs a daily limit for no-click elsewhere, never past the code ceiling", () => {
    const tool = { scope: "tool" as const, scopeKey: "mcp:G#send_message", checks: [] };
    expect(policyRowProblem({ ...tool, decision: "auto", caps: {} }, cover(["irreversible-external"], ["send"]))).toMatch(/daily limit/);
    expect(policyRowProblem({ ...tool, decision: "auto", caps: { perDay: ACT_PACING.email.perDay + 1 } }, cover(["irreversible-external"], ["send"]))).toMatch(/20 times a day/);
    expect(policyRowProblem({ ...tool, decision: "auto", caps: { perDay: ACT_PACING.email.perDay } }, cover(["irreversible-external"], ["send"]))).toBeNull();
    expect(policyRowProblem({ ...tool, decision: "auto", caps: { perDay: 5, teamPerDay: 41 } }, cover(["irreversible-external"], ["send"]))).toMatch(/team/);
  });
  it("leaves tightening and the space's own work alone", () => {
    expect(policyRowProblem({ scope: "class", scopeKey: "irreversible-external", decision: "block", caps: {}, checks: [] }, cover(["irreversible-external"]))).toBeNull();
    expect(policyRowProblem({ scope: "class", scopeKey: "internal-write", decision: "auto", caps: {}, checks: [] }, cover(["internal-write"]))).toBeNull();
  });
});

describe("the rest", () => {
  it("binds every session only with never and approve-then-press", () => {
    expect(["auto", "ask", "ticket", "block"].map((d) => bindsEverySession(d as never))).toEqual([false, false, true, true]);
  });
  it("ceilings come from today's pacing", () => {
    expect(autoCeiling("post").perDay).toBe(ACT_PACING.post.perDay);
    expect(autoCeiling("dm").perDay).toBe(ACT_PACING.dm.perDay);
    expect(autoCeiling("delete").perDay).toBe(ACT_PACING.email.perDay);
  });
  it("seals the same bytes whatever order a row's fields arrive in", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe('{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}');
    const a = policySealText({ spaceId: "S", scope: "tool", scopeKey: "k", decision: "auto", caps: { gapMs: 60000, perDay: 5 }, checks: [] });
    const b = policySealText({ checks: [], caps: { perDay: 5, gapMs: 60000 }, decision: "auto", scopeKey: "k", scope: "tool", spaceId: "S" });
    expect(a).toBe(b);
    expect(policySealText({ spaceId: "S", scope: "tool", scopeKey: "k", decision: "auto", caps: { perDay: 6 }, checks: [] })).not.toBe(a.replace("60000", ""));
  });
});
