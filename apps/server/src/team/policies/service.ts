import {
  CLASS_FLOORS, POLICY_CHECK_WORDS, POLICY_DECISION_WORDS, REALM_TOOL_CLASSES, RISK_CLASSES, RISK_CLASS_WORDS, classifyTool, connectorAtHost, decisionRank, floorFor, policyRowProblem, policySealText, policyStampScope,
  resolvePolicy, riskRank, toolClassSealText, toolClassStampScope, toolScopeKey, visibleToModel,
  type PolicyCall, type RiskClass, type TeamPolicies, type TeamPolicyConnector, type TeamPolicyInput, type TeamPolicyRow, type TeamPolicyTool,
  type ToolClass, type ToolClassInput, type ToolClassOverride, type ToolHints,
} from "@realm/contracts";
import type { McpLiveTool } from "../../mcp/hub";
import { RpcError } from "../../store/rows";
import type { SealChecker } from "./seals";
import type { PolicyStore, StoredPolicy } from "./store";
import { overrideFor, type StoredToolClass } from "./tool-classes";

/** What a person calls each of Realm's own toolsets. */
const PROVIDER_NAMES: Record<string, string> = {
  "realm-browser": "Browser", "realm-agent": "Agents", "realm-ui": "Questions", "realm-computer": "Computer control",
  "realm-terminal": "Terminals", "realm-app": "Realm's window", "realm-docs": "Documents", "realm-vm": "Machines",
  "realm-simulator": "Simulators", "realm-goal": "Goal", "realm-workspace": "Workspace", "realm-schedule": "Schedules",
  "realm-team": "Team", "realm-vault": "Vault", "realm-memory": "Memory",
};

export type PoliciesDeps = {
  profileIdOf(spaceId: string): string | null;
  spaceName(spaceId: string): string;
  /** A space that has ever had a role. Policies apply there and nowhere else. */
  isTeam(spaceId: string): boolean;
  /** The Realm providers a session in this space would see (`McpGateway.realmProvidersFor`). */
  realmProviders(spaceId: string): string[];
  /** The server rows this space runs, in order (`McpService.effectiveServerIds`). */
  serverIds(spaceId: string): string[];
  server(id: string): { id: string; name: string; url: string } | null;
  allowedTools(spaceId: string, id: string): string[] | null;
  /** A live `tools/list` (`McpHub.tools`) — the only place a tool's annotations are read. */
  liveTools(id: string): Promise<McpLiveTool[]>;
  overrides: { rows(profileId: string): StoredToolClass[]; put(profileId: string, connector: string, tool: string, cls: RiskClass, seal: string | null): void };
  store: PolicyStore;
  seals: SealChecker;
  log(spaceId: string, verb: string, object: string | null, detail: Record<string, unknown>): void;
  changed(spaceId: string): void;
};

/** A tool, where its class comes from: the connector, its name, and what its server said. */
export type ToolRef = { connector: string; tool: string; host?: string | null; annotations?: ToolHints | null };

const hostOf = (url: string): string | null => { try { return url ? new URL(url).host.toLowerCase() : null; } catch { return null; } };

/**
 * A team's policies (the dynamic-Teams plan, §4 and §7): the rows, what each tool a role could call
 * does under them, and the two writes the Policies page makes. Reading is for anyone holding the RPC
 * token; writing is open only where it tightens. A write that loosens anything — or leaves a row looser
 * than the floor — holds only with main's seal, which main makes at the person's press in Realm's own
 * window after macOS confirms them, and which this service asks main for. No agent tool reaches here.
 */
export class PoliciesService {
  constructor(private d: PoliciesDeps) {}

  isTeam(spaceId: string): boolean { return this.d.isTeam(spaceId); }

  /** What the person calls a connector: "Browser", "Linear", a server row's own name. */
  connectorName(connector: string): string {
    if (connector.startsWith("realm:")) return PROVIDER_NAMES[connector.slice(6)] ?? connector.slice(6);
    const row = connector.startsWith("mcp:") ? this.d.server(connector.slice(4)) : null;
    if (!row) return connector;
    const host = hostOf(row.url);
    return (host ? connectorAtHost(host)?.name : undefined) ?? row.name;
  }
  spaceName(spaceId: string): string { return this.d.spaceName(spaceId); }

  /** The team's rows, each saying whether main's seal on it checks out on this Mac now. Only reads: a
   *  team's class floors are written with its `team_meta` row (v54's trigger). */
  async rows(spaceId: string): Promise<{ rows: TeamPolicyRow[]; checked: boolean }> {
    const stored = this.d.store.forSpace(spaceId);
    const sealedOnes = stored.filter((r) => r.seal !== null);
    const { sealed, checked } = await this.d.seals.check(sealedOnes.map((r) => ({ scope: policyStampScope(r.spaceId, r.scope, r.scopeKey), text: policySealText(r), seal: r.seal! })));
    const ok = new Set(sealedOnes.filter((_, i) => sealed[i]).map((r) => r.id));
    return { rows: stored.map((r) => toRow(r, ok.has(r.id))), checked };
  }

  /** The profile's word on its tools, each lowering confirmed — or not — by main. */
  async overrides(profileId: string | null): Promise<Map<string, ToolClassOverride>> {
    const out = new Map<string, ToolClassOverride>();
    if (!profileId) return out;
    const rows = this.d.overrides.rows(profileId);
    const sealedOnes = rows.filter((r) => r.seal !== null);
    const { sealed } = await this.d.seals.check(sealedOnes.map((r) => ({ scope: toolClassStampScope(profileId, r.connector, r.tool), text: toolClassSealText({ profileId, ...r }), seal: r.seal! })));
    const ok = new Set(sealedOnes.filter((_, i) => sealed[i]));
    for (const r of rows) out.set(`${r.connector}\t${r.tool}`, { class: r.class, verb: r.verb, sealed: ok.has(r) });
    return out;
  }

  /** One tool's class in this space, the person's word included. */
  async classify(spaceId: string, ref: ToolRef): Promise<ToolClass> {
    const overrides = await this.overrides(this.d.profileIdOf(spaceId));
    return classifyTool(ref, overrideFor(overrides, ref.connector, ref.tool));
  }

  /**
   * The Policies page's facts: every tool a role in this space could call, by connector, with its class,
   * who decided it, and what a role's call does under the team's rows — plus the rows themselves.
   * "Does today" is for a role in its own mode; a role in Default mode is asked about anything that is
   * not a read whatever the rows say, and the page says so.
   */
  async view(spaceId: string): Promise<TeamPolicies> {
    const profileId = this.d.profileIdOf(spaceId);
    const [overrides, { rows, checked }] = await Promise.all([this.overrides(profileId), this.rows(spaceId)]);
    const tool = (connector: string, name: string, extra: { host?: string | null; annotations?: ToolHints | null }): TeamPolicyTool => {
      const c = classifyTool({ connector, tool: name, ...extra }, overrideFor(overrides, connector, name));
      const v = resolvePolicy(rows, { connector, tool: name, class: c.class, verb: c.verb, asksFirst: c.asksFirst !== null });
      return { tool: name, ...c, decision: v.decision, decidedBy: v.row?.scope ?? "floor", unconfirmed: v.unconfirmed !== null, asksToday: v.decision !== "auto" };
    };

    const realm = this.d.realmProviders(spaceId).map((provider): TeamPolicyConnector => {
      const connector = `realm:${provider}`;
      const names = Object.keys(REALM_TOOL_CLASSES).filter((n) => n.startsWith(`${provider}__`));
      return {
        connector, kind: "realm", name: PROVIDER_NAMES[provider] ?? provider, icon: null, reached: true,
        tools: names.map((n) => tool(connector, n.slice(provider.length + 2), {})),
      };
    }).filter((c) => c.tools.length > 0);

    const servers = await Promise.all(this.d.serverIds(spaceId).map(async (id): Promise<TeamPolicyConnector | null> => {
      const row = this.d.server(id);
      if (!row) return null;
      const connector = `mcp:${id}`;
      const host = hostOf(row.url);
      const vendor = host ? connectorAtHost(host) : undefined;
      const head = { connector, kind: "server" as const, name: vendor?.name ?? row.name, icon: vendor?.icon ?? null };
      let live: McpLiveTool[];
      try { live = await this.d.liveTools(id); } catch { return { ...head, reached: false, tools: [] }; }
      const allowed = this.d.allowedTools(spaceId, id);
      const listed = live.filter((t) => visibleToModel(t.ui) && (!allowed || allowed.includes(t.name)));
      return { ...head, reached: true, tools: listed.map((t) => tool(connector, t.name, { host, annotations: (t.def.annotations ?? null) as ToolHints | null })) };
    }));

    return {
      spaceId, spaceName: this.d.spaceName(spaceId), profileId,
      connectors: [...realm, ...servers.filter((s): s is TeamPolicyConnector => s !== null)],
      rows, sealsChecked: checked,
    };
  }

  /**
   * The team's policies for a role to plan inside (`policy_read`), in the Policies page's words: each
   * kind of action, then every rule narrower than a kind — a verb, a connection, one tool — with its
   * limits and checks. Only what is in force: a looser row nothing confirmed reads as the rule around it.
   */
  async describe(spaceId: string): Promise<string> {
    const view = await this.view(spaceId);
    const named = (r: TeamPolicyRow): string => {
      if (r.scope === "verb") return `Every "${r.scopeKey}"`;
      if (r.scope === "connector") return this.connectorName(r.scopeKey);
      if (r.scope === "tool") { const i = r.scopeKey.lastIndexOf("#"); return `${this.connectorName(r.scopeKey.slice(0, i))}: ${r.scopeKey.slice(i + 1)}`; }
      return r.scopeKey;
    };
    const lines = RISK_CLASSES.map((c) => {
      const r = view.rows.find((x) => x.scope === "class" && x.scopeKey === c);
      const d = r && (r.sealed || decisionRank(r.decision) >= decisionRank(CLASS_FLOORS[c])) ? r.decision : CLASS_FLOORS[c];
      return `- ${RISK_CLASS_WORDS[c]}: ${POLICY_DECISION_WORDS[d]}`;
    });
    const narrower = view.rows.filter((r) => r.scope !== "class").map((r) => {
      const inForce = r.sealed || r.decision !== "auto";
      const limits = r.caps.perDay !== undefined ? ` · up to ${r.caps.perDay} a day` : "";
      const checks = r.checks.length > 0 ? ` · checks: ${r.checks.map((c) => POLICY_CHECK_WORDS[c.id]).join(", ")}` : "";
      return `- ${named(r)}: ${inForce ? POLICY_DECISION_WORDS[r.decision] : "not confirmed on this Mac, so the rule around it applies"}${limits}${checks}`;
    });
    return [`${view.spaceName}'s policies for its roles:`, ...lines, ...(narrower.length ? ["Rules of their own:", ...narrower] : []),
      "Shell commands and web fetches follow your mode and ask. A call the policy refuses is not run; propose outward work with review_submit."].join("\n");
  }

  /**
   * Write one row. Refused outright when a rule forbids what it says (`policyRowProblem`). A write that
   * would make any call it governs looser than it is now, or leave a row looser than the floor, holds
   * only with the person's press: main sealed exactly this row when macOS confirmed them, and the seal
   * is spent here. Any other write tightens, is written as it is, and moves the scope's stamp on, so a
   * copy of an older, looser sealed row put back no longer checks out.
   */
  async set(input: TeamPolicyInput): Promise<TeamPolicyRow> {
    if (!this.d.isTeam(input.spaceId)) throw new RpcError("NOT_A_TEAM", "Policies are a team's, and this space has no roles.");
    const view = await this.view(input.spaceId);
    const calls = coveredCalls(input, view);
    const cover = {
      classes: [...new Set(calls.map((c) => c.class))],
      irreversibleVerbs: [...new Set(calls.filter((c) => c.class === "irreversible-external").map((c) => c.verb))],
    };
    const problem = policyRowProblem(input, cover);
    if (problem) throw new RpcError("POLICY_REFUSED", problem);
    const rank = decisionRank(input.decision);
    const loosens = calls.some((c) => rank < decisionRank(resolvePolicy(view.rows, c).decision) || rank < decisionRank(floorFor(c)));
    const text = policySealText(input);
    const scope = policyStampScope(input.spaceId, input.scope, input.scopeKey);
    let stored: StoredPolicy;
    if (loosens) {
      const seal = await this.d.seals.consume(text);
      if (!seal) throw new RpcError("POLICY_NEEDS_PRESS", "Loosening a rule takes your press on the team's Policies page, confirmed by macOS. Nothing changed.");
      stored = this.d.store.put(input, seal);
      this.d.seals.remember({ scope, text, seal });
      this.d.log(input.spaceId, "policy_loosened", input.scopeKey, { scope: input.scope, decision: input.decision, caps: input.caps });
    } else {
      stored = this.d.store.put(input, null);
      await this.d.seals.bump(scope);
      this.d.log(input.spaceId, "policy_set", input.scopeKey, { scope: input.scope, decision: input.decision, caps: input.caps });
    }
    this.d.changed(input.spaceId);
    return toRow(stored, loosens);
  }

  /**
   * A person's answer to "What does this do?" for one tool. Raising its class is open. Lowering it below
   * what Realm derived — "Only reads" for a tool nobody labelled — is a loosening, and takes the press.
   */
  async setToolClass(input: ToolClassInput): Promise<{ class: RiskClass; sealed: boolean }> {
    if (!this.d.isTeam(input.spaceId)) throw new RpcError("NOT_A_TEAM", "Policies are a team's, and this space has no roles.");
    const profileId = this.d.profileIdOf(input.spaceId);
    if (!profileId) throw new RpcError("NOT_FOUND", "This space has no profile.");
    const ref = await this.refFor(input.spaceId, input.connector, input.tool);
    if (!ref) throw new RpcError("NOT_FOUND", "No role in this space can call that tool.");
    const derived = classifyTool(ref, null);
    const scope = toolClassStampScope(profileId, input.connector, input.tool);
    if (riskRank(input.class) < riskRank(derived.class)) {
      const text = toolClassSealText({ profileId, connector: input.connector, tool: input.tool, class: input.class });
      const seal = await this.d.seals.consume(text);
      if (!seal) throw new RpcError("POLICY_NEEDS_PRESS", "Saying a tool does less than Realm reads takes your press on the team's Policies page, confirmed by macOS. Nothing changed.");
      this.d.overrides.put(profileId, input.connector, input.tool, input.class, seal);
      this.d.seals.remember({ scope, text, seal });
    } else {
      this.d.overrides.put(profileId, input.connector, input.tool, input.class, null);
      await this.d.seals.bump(scope);
    }
    this.d.log(input.spaceId, "tool_class_set", input.tool, { connector: input.connector, class: input.class });
    this.d.changed(input.spaceId);
    return { class: input.class, sealed: riskRank(input.class) < riskRank(derived.class) };
  }

  /** Where one of this space's tools comes from, for classing it: Realm's table, or its server's own
   *  listing. Null when no role here could call it. */
  private async refFor(spaceId: string, connector: string, tool: string): Promise<ToolRef | null> {
    if (connector.startsWith("realm:")) return REALM_TOOL_CLASSES[`${connector.slice(6)}__${tool}`] ? { connector, tool } : null;
    if (!connector.startsWith("mcp:")) return null;
    const id = connector.slice(4);
    if (!this.d.serverIds(spaceId).includes(id)) return null;
    const row = this.d.server(id);
    if (!row) return null;
    const live = (await this.d.liveTools(id).catch(() => [] as McpLiveTool[])).find((t) => t.name === tool);
    return live ? { connector, tool, host: hostOf(row.url), annotations: (live.def.annotations ?? null) as ToolHints | null } : null;
  }
}

export const toRow = (r: StoredPolicy, sealed: boolean): TeamPolicyRow => ({
  id: r.id, spaceId: r.spaceId, scope: r.scope, scopeKey: r.scopeKey, decision: r.decision, caps: r.caps, checks: r.checks,
  setBy: r.setBy, sealed, createdAt: r.createdAt, updatedAt: r.updatedAt,
});

/**
 * The calls a row would govern, from what the page lists. A row that names nothing listed — a verb no
 * tool has yet, a server that did not answer — is checked as if it governed something that can't be
 * taken back, the reading that asks the most of it.
 */
export function coveredCalls(row: Pick<TeamPolicyInput, "scope" | "scopeKey">, view: Pick<TeamPolicies, "connectors">): PolicyCall[] {
  const all: PolicyCall[] = view.connectors.flatMap((c) => c.tools.map((t) => ({ connector: c.connector, tool: t.tool, class: t.class, verb: t.verb, asksFirst: t.asksFirst !== null })));
  const phantom = (o: Partial<PolicyCall>): PolicyCall => ({ connector: "", tool: "", class: "irreversible-external", verb: "", ...o });
  switch (row.scope) {
    case "class": return [...all.filter((c) => c.class === row.scopeKey), phantom({ class: row.scopeKey as RiskClass })];
    case "verb": { const mine = all.filter((c) => c.verb === row.scopeKey); return mine.length > 0 ? mine : [phantom({ verb: row.scopeKey })]; }
    case "connector": { const mine = all.filter((c) => c.connector === row.scopeKey); return mine.length > 0 ? mine : [phantom({ connector: row.scopeKey })]; }
    case "tool": { const mine = all.filter((c) => toolScopeKey(c.connector, c.tool) === row.scopeKey); return mine.length > 0 ? mine : [phantom({})]; }
  }
}
