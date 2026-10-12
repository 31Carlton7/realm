import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { policySealText, policyStampScope, type RiskClass, type TeamPolicyInput } from "@realm/contracts";
import { openDatabase, type Db } from "../../db/database";
import type { McpLiveTool } from "../../mcp/hub";
import { RpcError } from "../../store/rows";
import { SealChecker, type SealBridge, type SealItem } from "./seals";
import { PoliciesService, type PoliciesDeps } from "./service";
import { PolicyStore } from "./store";
import type { StoredToolClass } from "./tool-classes";

const live = (name: string, annotations?: Record<string, unknown>, ui: McpLiveTool["ui"] = null): McpLiveTool =>
  ({ name, description: "", inputSchema: { type: "object" }, ui, def: { name, inputSchema: { type: "object" }, ...(annotations ? { annotations } : {}) } });

const SERVERS: Record<string, { id: string; name: string; url: string }> = {
  LIN: { id: "LIN", name: "realm-linear", url: "https://mcp.linear.app/mcp" },
  CRM: { id: "CRM", name: "acme-crm", url: "" },
  GONE: { id: "GONE", name: "offline", url: "https://offline.example.com/mcp" },
};

/**
 * Main's side of the seals, in memory: a press makes a seal for exactly one text, spent by the server's
 * ask; a seal checks out only for the text and scope it was made for, and only until its scope's stamp
 * moves on.
 */
export class FakeMain {
  private seals = new Map<string, { scope: string; text: string; gen: number }>();
  private pressed = new Map<string, string>();
  private stamps = new Map<string, number>();
  private n = 0;
  connected = true;
  bumps: string[] = [];

  /** The person's press on the Policies page, confirmed by macOS. */
  press(scope: string, text: string): void {
    const gen = (this.stamps.get(scope) ?? 0) + 1;
    this.stamps.set(scope, gen);
    const seal = `seal-${++this.n}`;
    this.seals.set(seal, { scope, text, gen });
    this.pressed.set(text, seal);
  }

  bridge: SealBridge = {
    connected: () => this.connected,
    verify: async (items: SealItem[]) => ({ sealed: items.map((i) => {
      const s = this.seals.get(i.seal);
      return !!s && s.scope === i.scope && s.text === i.text && s.gen === (this.stamps.get(i.scope) ?? 0);
    }) }),
    consume: async (text: string) => { const seal = this.pressed.get(text) ?? null; this.pressed.delete(text); return { seal }; },
    bump: async (scope: string) => { this.bumps.push(scope); this.stamps.set(scope, (this.stamps.get(scope) ?? 0) + 1); return { ok: true }; },
  };
}

function home(): Db {
  const db = openDatabase(join(tempDir("realm-policies-"), "realm.db"));
  db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES ('P1', 'Me', 'user', '#000', 0, 1, 1)").run();
  db.prepare("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at) VALUES ('S', 'P1', 'Versed', 'x', 0, '/tmp/s', 1, 1)").run();
  // The team is made: its meta row, and with it (v54's trigger) its four class floors.
  db.prepare("INSERT INTO team_meta (space_id, template, template_version, created_at) VALUES ('S', NULL, NULL, 1)").run();
  return db;
}

function service(over: Partial<PoliciesDeps> = {}, o: { overrides?: StoredToolClass[]; main?: FakeMain; db?: Db } = {}) {
  const db = o.db ?? home();
  const main = o.main ?? new FakeMain();
  const overrides = o.overrides ?? [];
  const logged: string[] = [];
  const deps: PoliciesDeps = {
    profileIdOf: () => "P1",
    spaceName: () => "Versed",
    isTeam: () => true,
    realmProviders: () => ["realm-team", "realm-vault"],
    serverIds: () => ["LIN", "CRM", "GONE"],
    server: (id) => SERVERS[id] ?? null,
    allowedTools: () => null,
    liveTools: async (id) => {
      if (id === "LIN") return [live("list_issues", { readOnlyHint: true }), live("save_issue", { readOnlyHint: true }), live("merge_diff")];
      if (id === "CRM") return [live("get_deal", { readOnlyHint: true }), live("update_deal"), live("email_contact", { readOnlyHint: true }), live("post_update"), live("open_view", undefined, { resourceUri: "ui://v", visibility: ["app"] } as never)];
      throw new Error("ECONNREFUSED");
    },
    overrides: {
      rows: () => overrides,
      put: (_p, connector, tool, cls, seal) => {
        const i = overrides.findIndex((r) => r.connector === connector && r.tool === tool);
        const row = { connector, tool, class: cls, verb: null, seal };
        if (i >= 0) overrides[i] = row; else overrides.push(row);
      },
    },
    store: new PolicyStore(db),
    seals: new SealChecker(main.bridge),
    log: (_s, verb, object) => { logged.push(`${verb}:${object}`); },
    changed: () => {},
    ...over,
  };
  return { svc: new PoliciesService(deps), db, main, logged, overrides };
}

const toolOf = async (svc: PoliciesService, connector: string, tool: string) =>
  (await svc.view("S")).connectors.find((c) => c.connector === connector)!.tools.find((t) => t.tool === tool)!;

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { return e instanceof RpcError ? `${e.code}: ${e.message}` : String(e); }
  return "held";
};

describe("PoliciesService.view", () => {
  it("names a connector Realm offers by its vendor and classes it from the vendor table, not the server's word", async () => {
    const v = await service().svc.view("S");
    const linear = v.connectors.find((c) => c.connector === "mcp:LIN")!;
    expect(linear).toMatchObject({ name: "Linear", icon: "linear", reached: true });
    expect(linear.tools.map((t) => [t.tool, t.class, t.source])).toEqual([
      ["list_issues", "read", "vendor"], ["save_issue", "reversible-external", "vendor"], ["merge_diff", "irreversible-external", "vendor"],
    ]);
  });

  it("keeps a server it could not reach, with no tools, rather than dropping it", async () => {
    const v = await service().svc.view("S");
    expect(v.connectors.find((c) => c.connector === "mcp:GONE")).toMatchObject({ name: "offline", reached: false, tools: [] });
  });

  it("lists only what a role could be handed: the space's allowlist, and never a tool only its view may call", async () => {
    const v = await service({ allowedTools: (_s, id) => (id === "CRM" ? ["get_deal", "update_deal", "open_view"] : null) }).svc.view("S");
    // THE MUTANT: the app-only filter dropped — `open_view` would show as a tool a role can call.
    expect(v.connectors.find((c) => c.connector === "mcp:CRM")!.tools.map((t) => t.tool)).toEqual(["get_deal", "update_deal"]);
  });

  it("gives a team its four class floors as rows, and says what a role's call does under them", async () => {
    const { svc } = service();
    const v = await svc.view("S");
    expect(v.rows.filter((r) => r.scope === "class").map((r) => [r.scopeKey, r.decision]).sort()).toEqual([
      ["internal-write", "auto"], ["irreversible-external", "ask"], ["read", "auto"], ["reversible-external", "ask"],
    ]);
    expect(v.connectors.filter((c) => c.kind === "server").flatMap((c) => c.tools).filter((t) => t.class !== "read").every((t) => t.asksToday)).toBe(true);
    const team = v.connectors.find((c) => c.connector === "realm:realm-team")!;
    expect(team.name).toBe("Team");
    expect(team.tools.find((t) => t.tool === "record_read")).toMatchObject({ class: "read", asksToday: true, decision: "ask", decidedBy: "floor" });
    expect(team.tools.find((t) => t.tool === "policy_read")).toMatchObject({ class: "read", asksToday: false });
    expect(v.connectors.find((c) => c.connector === "realm:realm-vault")!.tools.find((t) => t.tool === "vault_http"))
      .toMatchObject({ class: "irreversible-external", asksToday: true });
  });

  it("applies a person's raise, and sets aside a lowering nothing confirmed", async () => {
    const overrides: StoredToolClass[] = [
      { connector: "mcp:CRM", tool: "get_deal", class: "irreversible-external", verb: "sync", seal: null },
      { connector: "mcp:CRM", tool: "*", class: "read", verb: null, seal: null },
    ];
    const crm = (await service({}, { overrides }).svc.view("S")).connectors.find((c) => c.connector === "mcp:CRM")!;
    expect(crm.tools.find((t) => t.tool === "get_deal")).toMatchObject({ class: "irreversible-external", source: "you", verb: "sync" });
    expect(crm.tools.find((t) => t.tool === "update_deal")).toMatchObject({ class: "irreversible-external", source: "unclassified", overrideIgnored: true });
    // A send that labels itself read-only is held up by the floor, and the wildcard cannot pull it down.
    expect(crm.tools.find((t) => t.tool === "email_contact")).toMatchObject({ class: "irreversible-external", source: "server", floor: "email", overrideIgnored: true });
  });

  it("reads no overrides for a space with no profile", async () => {
    let asked = false;
    await service({ profileIdOf: () => null, overrides: { rows: () => { asked = true; return []; }, put: () => {} } }).svc.view("S");
    expect(asked).toBe(false);
  });
});

describe("PoliciesService.set", () => {
  const row = (o: Partial<TeamPolicyInput>): TeamPolicyInput => ({ spaceId: "S", scope: "connector", scopeKey: "mcp:LIN", decision: "ask", caps: {}, checks: [], ...o });
  const pressFor = (main: FakeMain, r: TeamPolicyInput) => main.press(policyStampScope(r.spaceId, r.scope, r.scopeKey), policySealText(r));

  it("holds a tightening with no press, unsealed, and moves the scope's stamp on", async () => {
    const { svc, main, logged } = service();
    const r = row({ decision: "block" });
    const out = await svc.set(r);
    expect(out).toMatchObject({ scope: "connector", scopeKey: "mcp:LIN", decision: "block", setBy: "user", sealed: false });
    expect(main.bumps).toEqual([policyStampScope("S", "connector", "mcp:LIN")]);
    expect((await toolOf(svc, "mcp:LIN", "list_issues")).decision).toBe("block");
    expect(logged).toEqual(["policy_set:mcp:LIN"]);
  });

  it("refuses a loosening that holds no press, and changes nothing", async () => {
    const { svc } = service();
    await svc.set(row({ decision: "block" }));
    // THE MUTANT: `loosens` computed against the floor alone — block → ask would pass as "not looser".
    expect(await refusal(svc.set(row({ decision: "ask" })))).toMatch(/^POLICY_NEEDS_PRESS/);
    expect((await toolOf(svc, "mcp:LIN", "save_issue")).decision).toBe("block");
  });

  it("holds a loosening with the person's press for exactly that row, and not for another", async () => {
    const { svc, main } = service();
    await svc.set(row({ decision: "block" }));
    pressFor(main, row({ decision: "ask", scopeKey: "mcp:CRM" }));
    expect(await refusal(svc.set(row({ decision: "ask" })))).toMatch(/^POLICY_NEEDS_PRESS/);
    pressFor(main, row({ decision: "ask" }));
    expect(await svc.set(row({ decision: "ask" }))).toMatchObject({ decision: "ask", sealed: true });
    // The press is spent by the write: the same loosening again needs a press of its own.
    await svc.set(row({ decision: "block" }));
    expect(await refusal(svc.set(row({ decision: "ask" })))).toMatch(/^POLICY_NEEDS_PRESS/);
  });

  it("lets one tool that can't be taken back go without a click only with a daily cap at or under the ceiling", async () => {
    const { svc, main } = service();
    const send = (caps: TeamPolicyInput["caps"]) => row({ scope: "tool", scopeKey: "mcp:LIN#merge_diff", decision: "auto", caps });
    // THE MUTANT: the cap check dropped — a no-click with no limit would need only a press.
    expect(await refusal(svc.set(send({})))).toMatch(/^POLICY_REFUSED: .*daily limit/);
    // `merge` reads as neither a post nor a message: the ceiling is email's, 20 a day.
    expect(await refusal(svc.set(send({ perDay: 21 })))).toMatch(/^POLICY_REFUSED: .*more than 20 times a day/);
    expect(await refusal(svc.set(send({ perDay: 20 })))).toMatch(/^POLICY_NEEDS_PRESS/);
    pressFor(main, send({ perDay: 20, gapMs: 60_000 }));
    expect(await svc.set(send({ perDay: 20, gapMs: 60_000 }))).toMatchObject({ decision: "auto", sealed: true, caps: { perDay: 20, gapMs: 60_000 } });
    expect(await toolOf(svc, "mcp:LIN", "merge_diff")).toMatchObject({ decision: "auto", decidedBy: "tool", asksToday: false });
  });

  it("holds a post to today's posts ceiling, even pressed", async () => {
    const { svc, main } = service();
    const post = row({ scope: "tool", scopeKey: "mcp:CRM#post_update", decision: "auto", caps: { perDay: 4 } });
    pressFor(main, post);
    expect(await refusal(svc.set(post))).toMatch(/^POLICY_REFUSED: .*more than 3 times a day/);
  });

  it("never lets a whole kind of action that can't be taken back go without a click, pressed or not", async () => {
    const { svc, main } = service();
    const all = row({ scope: "class", scopeKey: "irreversible-external", decision: "auto", caps: { perDay: 1 } });
    pressFor(main, all);
    expect(await refusal(svc.set(all))).toMatch(/^POLICY_REFUSED: .*never a whole kind of action/);
    // …nor a connector that has one such tool among its others.
    const linear = row({ decision: "auto", caps: { perDay: 1 } });
    pressFor(main, linear);
    expect(await svc.set(linear)).toMatchObject({ sealed: true });
  });

  it("reads a sealed row someone edited or put back as if it were not there", async () => {
    const { svc, main, db } = service();
    const one = row({ scope: "tool", scopeKey: "mcp:LIN#merge_diff", decision: "auto", caps: { perDay: 5 } });
    pressFor(main, one);
    await svc.set(one);
    expect((await toolOf(svc, "mcp:LIN", "merge_diff")).decision).toBe("auto");
    // An agent's shell, writing realm.db: a larger cap under the same seal.
    db.prepare("UPDATE team_policies SET caps_json = '{\"perDay\":500}' WHERE scope = 'tool'").run();
    // THE MUTANT: an unsealed looser row taken at its word — the tampered no-click would stand.
    expect(await toolOf(svc, "mcp:LIN", "merge_diff")).toMatchObject({ decision: "ask", decidedBy: "class", unconfirmed: true });
    // And the true row put back after a tightening moved the stamp on reads the same way.
    const sealed = db.prepare("SELECT caps_json, seal FROM team_policies WHERE scope = 'tool'").get() as { seal: string };
    db.prepare("UPDATE team_policies SET caps_json = '{\"perDay\":5}' WHERE scope = 'tool'").run();
    expect((await toolOf(svc, "mcp:LIN", "merge_diff")).decision).toBe("auto");
    await svc.set({ ...one, decision: "ask", caps: {} });
    db.prepare("UPDATE team_policies SET decision = 'auto', caps_json = '{\"perDay\":5}', seal = ? WHERE scope = 'tool'").run(sealed.seal);
    expect(await toolOf(svc, "mcp:LIN", "merge_diff")).toMatchObject({ decision: "ask", unconfirmed: true });
  });

  it("reads every looser row as the floor when main is not there to vouch for it", async () => {
    const main = new FakeMain();
    const { svc, db } = service({}, { main });
    const one = row({ scope: "tool", scopeKey: "mcp:LIN#merge_diff", decision: "auto", caps: { perDay: 5 } });
    pressFor(main, one);
    await svc.set(one);
    main.connected = false;
    const fresh = service({}, { main, db }).svc;
    expect((await fresh.view("S")).sealsChecked).toBe(false);
    expect((await toolOf(fresh, "mcp:LIN", "merge_diff")).decision).toBe("ask");
  });
});

describe("PoliciesService.setToolClass", () => {
  it("raises a tool's class with no press, and lowers it only with one", async () => {
    const { svc, main, overrides } = service();
    const set = (cls: RiskClass) => svc.setToolClass({ spaceId: "S", connector: "mcp:CRM", tool: "update_deal", class: cls });
    expect(await refusal(set("read"))).toMatch(/^POLICY_NEEDS_PRESS/);
    expect(overrides).toEqual([]);
    main.press("tool-class:P1|mcp:CRM|update_deal", JSON.stringify({ class: "read", connector: "mcp:CRM", kind: "tool-class", profileId: "P1", tool: "update_deal" }));
    expect(await set("read")).toEqual({ class: "read", sealed: true });
    expect(await toolOf(svc, "mcp:CRM", "update_deal")).toMatchObject({ class: "read", source: "you", overrideIgnored: false });
    // Back up to "can't be taken back" is a raise: no press, and the stamp moves on.
    expect(await set("irreversible-external")).toEqual({ class: "irreversible-external", sealed: false });
    expect(main.bumps).toContain("tool-class:P1|mcp:CRM|update_deal");
  });

  it("refuses a tool no role here can call", async () => {
    const { svc } = service();
    expect(await refusal(svc.setToolClass({ spaceId: "S", connector: "mcp:NOPE", tool: "x", class: "irreversible-external" }))).toMatch(/^NOT_FOUND/);
  });
});
