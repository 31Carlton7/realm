import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  VAULT_HTTP_METHODS, VAULT_PLACEHOLDER, VAULT_PROVIDER_NAME, fenceUntrusted, vaultUrlHost, type VaultHttpResult,
} from "@realm/contracts";
import type { ProviderCallContext, RealmToolProvider } from "../../mcp/gateway";
import { clip, err, ok, parseArgs } from "../../mcp/tool-result";
import type { BrowserHostBridge } from "../../browsers/host-bridge";
import type { BrowserPermissionBroker } from "../../browsers/permissions";
import { signinName, type VaultService } from "./service";

export { VAULT_PROVIDER_NAME };

export type VaultAgentToolsDeps = {
  vault: Pick<VaultService, "secrets" | "grantsForRole" | "roleOf" | "check" | "note">;
  bridge: Pick<BrowserHostBridge, "call">;
  broker: Pick<BrowserPermissionBroker, "gate">;
  profileOf: (spaceId: string) => string | null;
  isTeam: (spaceId: string) => boolean;
  mcp: { providerEnabled(spaceId: string, name: string): boolean };
};

const HttpArgs = z.object({
  secret: z.string().min(1).max(64),
  method: z.string().transform((m) => m.toUpperCase()).pipe(z.enum(VAULT_HTTP_METHODS)).default("GET"),
  url: z.string().min(1).max(2_000),
  headers: z.record(z.string().max(200), z.string().max(4_000)).default({}),
  body: z.string().max(256_000).optional(),
}).strict();

const TOOLS: Tool[] = [
  {
    name: "vault_list",
    description: "The secrets this session may use from the team's vault, by name: API keys (with the hosts each is locked to) and sign-ins (with the credentialId browser_fill_credential takes). Never a value — there is no way to read one. A team's role sees only what it has been granted. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vault_http",
    description: [
      `Make ONE HTTP request with a team API key in it, without ever seeing the key. Write ${VAULT_PLACEHOLDER} where the key goes — in a header's value (e.g. "Authorization": "Bearer ${VAULT_PLACEHOLDER}") or the body; never in the URL.`,
      "Realm makes the request itself, only to a host the key is locked to (https; plain http only to this Mac), follows no redirects, and returns the status and body with every form of the key removed.",
      "`secret` is the key's name from vault_list. A team role may use only keys granted to it, at the hosts its grant names; anything else is refused and logged.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        secret: { type: "string", description: "the key's name, e.g. REVENUECAT_SECRET_KEY" },
        method: { type: "string", enum: [...VAULT_HTTP_METHODS] },
        url: { type: "string", description: "https://host/path?query — the host must be one the key is locked to" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "string" },
      },
      required: ["secret", "url"],
      additionalProperties: false,
    },
  },
];

/**
 * The `realm-vault` provider: how an agent in a team's space uses the team's secrets by name.
 *
 * Listed only in a team's space. There is no tool that adds a secret, makes or widens a grant, lets a
 * grant through without asking, or returns a value — those are the Vault page's, over renderer IPC
 * and RPC an agent's tools do not reach, and the value never leaves Electron main.
 */
export function createVaultAgentProvider(d: VaultAgentToolsDeps): RealmToolProvider {
  return {
    name: VAULT_PROVIDER_NAME,
    async tools(ctx: ProviderCallContext): Promise<Tool[]> {
      if (!d.mcp.providerEnabled(ctx.spaceId, VAULT_PROVIDER_NAME) || !d.isTeam(ctx.spaceId)) return [];
      return TOOLS;
    },
    async call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult> {
      if (!d.mcp.providerEnabled(ctx.spaceId, VAULT_PROVIDER_NAME))
        return err(`the ${VAULT_PROVIDER_NAME} tools are disabled for this space — mcp.setProviderEnabled turns them back on.`);
      if (!d.isTeam(ctx.spaceId)) return err("this space has no team, so it has no vault");
      try {
        if (tool === "vault_list") return await list(d, ctx);
        if (tool === "vault_http") return await http(d, ctx, args);
        return err(`unknown tool "${tool}" — this provider has: ${TOOLS.map((t) => t.name).join(", ")}`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

async function list(d: VaultAgentToolsDeps, ctx: ProviderCallContext): Promise<CallToolResult> {
  const owner = d.vault.roleOf(ctx.sessionId);
  const secrets = await d.vault.secrets(ctx.spaceId);
  const lines: string[] = [];
  if (owner) {
    // A role is told what it holds and nothing else: the names of the other secrets are the team's.
    for (const g of d.vault.grantsForRole(owner.role.id)) {
      if (g.kind === "key") lines.push(`- ${g.name} — API key, only to ${g.hosts.join(", ")}. Use with vault_http.`);
      else lines.push(`- ${g.name} — sign-in, credentialId ${g.secretId}. Fill with browser_fill_credential.`);
    }
  } else {
    for (const k of secrets.keys) lines.push(`- ${k.name} — API key, only to ${k.allowedHosts.join(", ")}${k.label ? ` · ${clip(k.label, 60)}` : ""}. Use with vault_http.`);
    for (const c of secrets.signins.filter((s) => s.spaceId === ctx.spaceId)) {
      lines.push(`- ${signinName(c.origin, c.username)} — the team's sign-in, credentialId ${c.id}. Fill with browser_fill_credential.`);
    }
  }
  if (lines.length === 0) {
    return ok(owner
      ? `${owner.role.name} holds no grants in this team's vault. The person grants secrets in the team's Vault page; you cannot.`
      : "This team's vault holds no keys or sign-ins of its own yet. The person adds them in the team's Vault page.");
  }
  return ok(`What you may use (names only — Realm never gives you a value):\n${lines.join("\n")}`);
}

async function http(d: VaultAgentToolsDeps, ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
  const a = parseArgs(HttpArgs, raw); if ("error" in a) return a.error;
  const v = a.value;
  const target = vaultUrlHost(v.url);
  if ("error" in target) return err(`refused: ${target.error}`);
  const host = target.host;
  const usesKey = Object.values(v.headers).some((h) => h.includes(VAULT_PLACEHOLDER)) || (v.body?.includes(VAULT_PLACEHOLDER) ?? false);
  if (!usesKey) return err(`refused: write ${VAULT_PLACEHOLDER} where the key goes — in a header's value or the body.`);

  const owner = d.vault.roleOf(ctx.sessionId);
  const secrets = await d.vault.secrets(ctx.spaceId);
  const key = secrets.keys.find((k) => k.name === v.secret || k.id === v.secret);
  if (!key) {
    if (owner) d.vault.note(ctx, { secret: { id: v.secret, kind: "key", name: clip(v.secret, 64) }, host, refused: "no such key" }, { roleId: owner.role.id, runId: owner.run.id });
    return err(`refused: this team's vault has no key named "${clip(v.secret, 64)}". vault_list shows what you may use.`);
  }
  const ref = { id: key.id, kind: "key" as const, name: key.name };
  const check = await d.vault.check(ctx, ref, host);
  if ("refuse" in check) return err(check.refuse);
  // Refused here, before any card, as main will refuse it again: a card for a request that can never
  // be made teaches the person to approve without reading.
  if (!key.allowedHosts.some((h) => h.toLowerCase() === host)) {
    d.vault.note(ctx, { secret: ref, host, refused: `${key.name} is not locked to ${host}` }, { roleId: check.roleId, runId: check.runId });
    return err(`refused: ${key.name} is locked to ${key.allowedHosts.join(", ")}, not ${host}.`);
  }

  let path = "/";
  try { const u = new URL(v.url); path = `${u.pathname}${u.search ? "?…" : ""}`; } catch { /* checked above */ }
  // The card is Realm's words about Realm's facts — the key's name, the host — with the agent's path
  // attributed and clipped. It never shows a value, because nothing here has one.
  const title = `Put ${key.name} into one ${v.method} request to ${host} (the agent asks for ${clip(path, 80)}). Realm makes the request; the agent never receives the key.`;
  const gate = await d.broker.gate(ctx.sessionId, "vault_http", title,
    { secret: key.name, method: v.method, host, path: clip(path, 200) }, "vault_http",
    check.unattended ? { preapproved: true } : { alwaysPrompt: true });
  if (!gate.allowed) {
    d.vault.note(ctx, { secret: ref, host, refused: clip(gate.reason, 120) }, { roleId: check.roleId, runId: check.runId });
    return err(gate.reason);
  }

  const result = (await d.bridge.call("vaultHttp", {
    profileId: d.profileOf(ctx.spaceId) ?? "", spaceId: ctx.spaceId, secretId: key.id, hosts: check.hosts,
    method: v.method, url: v.url, headers: v.headers, body: v.body ?? null,
    ...(check.roleId ? { roleId: check.roleId } : {}), ...(check.runId ? { runId: check.runId } : {}),
  })) as VaultHttpResult;
  if (!result.ok) {
    d.vault.note(ctx, { secret: ref, host, refused: result.refused === "no_presence" ? "nobody confirmed it on this Mac" : result.error }, { roleId: check.roleId, runId: check.runId });
    return err(`the request was not made: ${result.error}`);
  }
  d.vault.note(ctx, { secret: ref, host, how: check.unattended ? "unattended" : "card", status: result.status }, { roleId: check.roleId, runId: check.runId });
  const head = [`HTTP ${result.status}`, result.contentType ? `content-type: ${result.contentType}` : null,
    result.location ? `location: ${result.location} (not followed — call again to go there)` : null].filter(Boolean).join("\n");
  const body = result.body ? `\n\n${fenceUntrusted(result.body, "THE RESPONSE BODY")}${result.truncated ? "\n(cut short — the response was longer)" : ""}` : "\n\n(empty body)";
  return ok(`${head}${body}`);
}
