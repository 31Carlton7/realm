import { describe, expect, it } from "vitest";
import { classifyTool, type PolicyDecision, type TeamPolicyRow, type ToolClass } from "@realm/contracts";
import type { GateOptions } from "../../browsers/permissions";
import { PolicyGate, type GatedCall, type PolicyGateDeps } from "./gate";

/**
 * The one gate at Realm's gateway, with the team's rows, the session's mode and the broker stood in
 * for. What it must hold (the owner's decisions, 10-09): "never" and "approve, then press" bind every
 * session in the space, the person's own in Full access included; "ask" and "without asking" bind only
 * the team's role runs; a no-click past its caps asks; and only the person's own yes skips the ordinary
 * gate inside a call.
 */

const row = (o: Partial<TeamPolicyRow>): TeamPolicyRow => ({
  id: "R1", spaceId: "S", scope: "connector", scopeKey: "mcp:CRM", decision: "ask", caps: {}, checks: [], setBy: "user", sealed: false, createdAt: 1, updatedAt: 1, ...o,
});

const FLOORS: TeamPolicyRow[] = [
  row({ id: "F1", scope: "class", scopeKey: "read", decision: "auto", setBy: "migration" }),
  row({ id: "F2", scope: "class", scopeKey: "internal-write", decision: "auto", setBy: "migration" }),
  row({ id: "F3", scope: "class", scopeKey: "reversible-external", decision: "ask", setBy: "migration" }),
  row({ id: "F4", scope: "class", scopeKey: "irreversible-external", decision: "ask", setBy: "migration" }),
];

type Card = { title: string; opts: GateOptions };

function gate(o: { rows?: TeamPolicyRow[]; role?: boolean; mode?: string; answer?: boolean; team?: boolean; autos?: number; lastAuto?: number | null; now?: number } = {}) {
  const cards: Card[] = [];
  const logged: { verb: string; actor: string; detail: Record<string, unknown> }[] = [];
  const deps: PolicyGateDeps = {
    policies: {
      isTeam: () => o.team ?? true,
      spaceName: () => "Versed",
      rows: async () => ({ rows: [...FLOORS, ...(o.rows ?? [])], checked: true }),
      classify: async (_s, ref): Promise<ToolClass> => classifyTool(ref),
      connectorName: (c) => (c === "mcp:CRM" ? "acme-crm" : c),
    },
    store: { autoCalls: () => ({ count: o.autos ?? 0 }), lastAuto: () => o.lastAuto ?? null },
    roleRunOf: () => (o.role ? { roleId: "ROLE", runId: "RUN", sessionId: "SESS" } : null),
    permissionMode: () => o.mode ?? "acceptEdits",
    broker: { gate: async (_s, _k, title, _i, _n, opts) => { cards.push({ title, opts }); return o.answer === false ? { allowed: false, reason: "the user denied this action" } : { allowed: true }; } },
    log: (_s, actor, verb, _o, detail) => { logged.push({ verb, actor, detail }); },
    now: () => o.now ?? new Date(2026, 9, 11, 12, 0).getTime(),
  };
  return { g: new PolicyGate(deps), cards, logged };
}

/** An MCP server's tool with no labels: Realm cannot classify it, so it reads as irreversible. */
const SEND: GatedCall = { connector: "mcp:CRM", tool: "send_thing", fullName: "acme-crm__send_thing", annotations: null, args: { to: "a@b.c" } };
/** One its server labels open-world but not destructive: reversible. */
const SAVE: GatedCall = { connector: "mcp:CRM", tool: "save_thing", fullName: "acme-crm__save_thing", annotations: { openWorldHint: true, destructiveHint: false }, args: {} };
/** A read. */
const READ: GatedCall = { connector: "mcp:CRM", tool: "read_thing", fullName: "acme-crm__read_thing", annotations: { readOnlyHint: true }, args: {} };

const ctx = { sessionId: "SESS", spaceId: "S" };
const on = (decision: PolicyDecision, o: Partial<TeamPolicyRow> = {}) => row({ decision, ...o });

describe("PolicyGate — whose sessions a rule binds", () => {
  it("refuses the person's own Full-access session a call the team's policy says never to", async () => {
    const { g, cards, logged } = gate({ rows: [on("block")], mode: "bypassPermissions" });
    // THE MUTANT: "never" read as binding role runs only — the person's bypass session would send.
    const a = await g.check(ctx, SEND);
    expect(a).toMatchObject({ ok: false, summary: "blocked: Versed's policy says never" });
    expect(a.ok === false && a.message).toMatch(/never lets acme-crm: send thing run/);
    expect(cards).toEqual([]);
    expect(logged.map((l) => [l.verb, l.actor])).toEqual([["policy_blocked", "user"]]);
  });

  it("holds the person's own session to approve-then-press: the call does not run", async () => {
    const { g, logged } = gate({ rows: [on("ticket")], mode: "bypassPermissions" });
    // THE MUTANT: `bindsEverySession` answering only for block.
    expect(await g.check(ctx, SEND)).toMatchObject({ ok: false, summary: "held: Versed's policy sends this through Review" });
    expect(logged.map((l) => l.verb)).toEqual(["policy_ticket"]);
  });

  it("leaves the person's own session to its mode where the team's rule only asks", async () => {
    const { g, cards } = gate({ rows: [on("ask")], mode: "bypassPermissions" });
    // THE MUTANT: "ask" binding every session — the person's Full access would get Realm's card.
    expect(await g.check(ctx, SEND)).toEqual({ ok: true, answered: false });
    expect(cards).toEqual([]);
  });

  it("binds a view's call (the person clicked it) only by never and approve-then-press", async () => {
    const { g, cards } = gate({ rows: [on("ask")], role: true });
    expect(await g.check({ ...ctx, fromView: true }, SEND)).toEqual({ ok: true, answered: false });
    expect(cards).toEqual([]);
    expect(await gate({ rows: [on("block")], role: true }).g.check({ ...ctx, fromView: true }, SEND)).toMatchObject({ ok: false });
  });

  it("does nothing at all outside a team's space", async () => {
    const { g, cards } = gate({ rows: [on("block")], team: false, role: true });
    expect(await g.check(ctx, SEND)).toEqual({ ok: true, answered: false });
    expect(cards).toEqual([]);
  });
});

describe("PolicyGate — a role's run", () => {
  it("asks per call for something that can't be taken back, naming the policy, with no 'always'", async () => {
    const { g, cards, logged } = gate({ role: true });
    expect(await g.check(ctx, SEND)).toEqual({ ok: true, answered: true });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.title).toBe("Versed's policy asks each time before acme-crm does something that can't be taken back");
    expect(cards[0]!.opts).toEqual({ alwaysPrompt: true });
    expect(logged.map((l) => [l.verb, l.actor, l.detail.allowed])).toEqual([["policy_asked", "role:ROLE", true]]);
  });

  it("asks once for the run for a change elsewhere that can be undone", async () => {
    const { g, cards } = gate({ role: true });
    await g.check(ctx, SAVE);
    expect(cards[0]!.opts).toEqual({ promptUnderBypass: true, perSession: true });
  });

  it("refuses a Realm tool that no provider has as unknown, before any card", async () => {
    // THE MUTANT: an unknown name classed as the riskiest tool and asked about. The person approved a
    // card for `ticket_post`, and the call then failed as a tool that does not exist.
    const { g, cards, logged } = gate({ role: true });
    const made = { connector: "realm:realm-team", tool: "ticket_post", fullName: "realm-team__ticket_post", args: {} };
    const a = await g.check(ctx, made);
    expect(a).toMatchObject({ ok: false, summary: "blocked: unknown tool" });
    expect(a.ok === false && a.message).toBe('unknown tool "ticket_post" — realm-team has no tool by that name. Nothing was run.');
    expect(cards).toEqual([]);
    expect(logged).toEqual([]);
    // A Realm tool it does have still goes to the rows.
    expect(await g.check(ctx, { ...made, tool: "record_update", fullName: "realm-team__record_update" })).toEqual({ ok: true, answered: false });
  });

  it("does not run a call the person denied on the policy's card", async () => {
    const { g } = gate({ role: true, answer: false });
    expect(await g.check(ctx, SEND)).toMatchObject({ ok: false, summary: "denied on the policy's card" });
  });

  it("lets a read through with no card, and leaves whatever asks inside the call to ask", async () => {
    const { g, cards } = gate({ role: true });
    // THE MUTANT: a floor's "without asking" answered for the person — a Realm tool's own card inside
    // the call (agent_ask, settings_set) would be skipped.
    expect(await g.check(ctx, READ)).toEqual({ ok: true, answered: false });
    expect(cards).toEqual([]);
  });

  it("refuses anything but a read in a read-only mode, whatever the rows say", async () => {
    const { g, cards } = gate({ role: true, mode: "plan", rows: [on("auto", { scope: "tool", scopeKey: "mcp:CRM#save_thing", sealed: true, caps: { perDay: 5 } })] });
    expect(await g.check(ctx, SAVE)).toMatchObject({ ok: false, summary: "blocked: a read-only mode" });
    expect(await g.check(ctx, READ)).toEqual({ ok: true, answered: false });
    expect(cards).toEqual([]);
  });

  it("asks in Default mode even where a sealed row says without asking", async () => {
    const { g, cards } = gate({ role: true, mode: "default", rows: [on("auto", { scope: "tool", scopeKey: "mcp:CRM#send_thing", sealed: true, caps: { perDay: 5 } })] });
    await g.check(ctx, SEND);
    expect(cards).toHaveLength(1);
  });

  it("runs a sealed no-click for one tool within its caps with no card, and logs it", async () => {
    const sealed = on("auto", { id: "T1", scope: "tool", scopeKey: "mcp:CRM#send_thing", sealed: true, caps: { perDay: 5, gapMs: 60_000, window: { start: 8, end: 22 } } });
    const { g, cards, logged } = gate({ role: true, rows: [sealed], autos: 4, lastAuto: new Date(2026, 9, 11, 11, 0).getTime() });
    expect(await g.check(ctx, SEND)).toEqual({ ok: true, answered: true });
    expect(cards).toEqual([]);
    expect(logged.map((l) => [l.verb, l.detail.rowId])).toEqual([["policy_auto", "T1"]]);
  });

  it("asks instead once a no-click's day is used, too soon after the last, or outside its hours", async () => {
    const sealed = on("auto", { id: "T1", scope: "tool", scopeKey: "mcp:CRM#send_thing", sealed: true, caps: { perDay: 5, gapMs: 60_000, window: { start: 8, end: 22 } } });
    // THE MUTANT: `>=` turned `>` in the day's count — a sixth would go without asking.
    const full = gate({ role: true, rows: [sealed], autos: 5 });
    await full.g.check(ctx, SEND);
    expect(full.cards[0]!.title).toMatch(/today's 5 without asking are used/);
    const soon = gate({ role: true, rows: [sealed], lastAuto: new Date(2026, 9, 11, 11, 59, 30).getTime() });
    await soon.g.check(ctx, SEND);
    expect(soon.cards[0]!.title).toMatch(/the last one went moments ago/);
    const late = gate({ role: true, rows: [sealed], now: new Date(2026, 9, 11, 23, 0).getTime() });
    await late.g.check(ctx, SEND);
    expect(late.cards[0]!.title).toMatch(/outside the hours/);
  });

  it("reads an unsealed no-click as the floor: the call asks", async () => {
    const { g, cards } = gate({ role: true, rows: [on("auto", { scope: "tool", scopeKey: "mcp:CRM#send_thing", sealed: false, caps: { perDay: 5 } })] });
    expect(await g.check(ctx, SEND)).toEqual({ ok: true, answered: true });
    expect(cards).toHaveLength(1);
  });
});

describe("PolicyGate.decides — whose card the engine skips", () => {
  it("answers for every gateway call of a role's run, and for the person's own only where it refuses", async () => {
    expect(await gate({ role: true }).g.decides("SESS", "S", SEND)).toBe(true);
    expect(await gate({}).g.decides("SESS", "S", SEND)).toBe(false);
    expect(await gate({ rows: [on("block")] }).g.decides("SESS", "S", SEND)).toBe(true);
    expect(await gate({ rows: [on("ticket")] }).g.decides("SESS", "S", SEND)).toBe(true);
    expect(await gate({ rows: [on("block")], team: false }).g.decides("SESS", "S", SEND)).toBe(false);
    expect(await gate({ rows: [on("block")] }).g.decides("SESS", "S", null)).toBe(false);
  });
});
