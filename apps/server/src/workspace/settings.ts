import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_SETTINGS, AGENT_SETTING_NAMES, type AgentSettingName } from "@realm/contracts";
import type { ProviderCallContext } from "../mcp/gateway";
import { err, ok, parseArgs } from "../mcp/tool-result";
import type { BrowserPermissionBroker } from "../browsers/permissions";
import type { RpcServer } from "../rpc/server";
import type { WorkspaceToolGroup } from "./agent-tools";

/**
 * `settings_get` and `settings_set`: the few of Realm's settings an agent may read and change — the
 * ones `AGENT_SETTINGS` lists, which says what is left off and why. Named, never keyed: an agent asks
 * for `theme`, not `ui.theme`, so there is no spelling of a key that reaches past the list.
 *
 * Agents were doing this already, by hand: a script opening Realm's RPC socket to write the theme
 * straight into the settings table. That reached every setting there is, and left the open windows
 * showing the old value until a restart. This reaches five, asks first, and every window follows.
 */
export type SettingsDeps = {
  settings: { get(key: string): unknown; set(key: string, value: unknown): void };
  broker: Pick<BrowserPermissionBroker, "gate">;
  rpc: Pick<RpcServer, "broadcast">;
};

const names = AGENT_SETTING_NAMES as [AgentSettingName, ...AgentSettingName[]];
const SettingsGetArgs = z.object({ name: z.enum(names).optional() }).strict();
const SettingsSetArgs = z.object({ name: z.string().min(1), value: z.union([z.string(), z.boolean()]) }).strict();

const listing = AGENT_SETTING_NAMES.map((n) => `${n} (${AGENT_SETTINGS[n].values.map((v) => JSON.stringify(v)).join(" | ")})`).join("; ");

const TOOLS: Tool[] = [
  {
    name: "settings_get",
    description: `Read Realm's own settings that you may change — ${AGENT_SETTING_NAMES.join(", ")} — with each one's current value and the values it takes. Give \`name\` for one. Read-only.`,
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", enum: [...AGENT_SETTING_NAMES], description: "one setting; omit for all of them" } },
      additionalProperties: false,
    },
  },
  {
    name: "settings_set",
    description: `Change one of Realm's own settings when the user asks you to — the window follows at once, as if they had changed it in Settings. Only these: ${listing}. Nothing about permissions, sign-ins, MCP servers or notifications can be changed here: those are the user's to set in Settings. Asks the user for permission unless you are in Full access.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", enum: [...AGENT_SETTING_NAMES], description: "which setting" },
        value: { description: "the new value, one of the values settings_get lists for it" },
      },
      required: ["name", "value"],
      additionalProperties: false,
    },
  },
];

export function createSettingsTools(d: SettingsDeps): WorkspaceToolGroup {
  return {
    tools: TOOLS,
    handlers: {
      settings_get: async (_ctx, raw) => get(d, raw),
      settings_set: async (ctx, raw) => setOne(d, ctx, raw),
    },
  };
}

/** The stored value, or what the app shows for it when nothing (or nothing it offers) is stored. */
function current(d: SettingsDeps, name: AgentSettingName): string | boolean {
  const s = AGENT_SETTINGS[name];
  const stored = d.settings.get(s.key);
  return (s.values as readonly unknown[]).includes(stored) ? (stored as string | boolean) : s.fallback;
}

function get(d: SettingsDeps, raw: unknown): CallToolResult {
  const args = parseArgs(SettingsGetArgs, raw); if ("error" in args) return args.error;
  const which = args.value.name ? [args.value.name] : AGENT_SETTING_NAMES;
  const lines = which.map((n) => {
    const s = AGENT_SETTINGS[n];
    return `- ${n}: ${JSON.stringify(current(d, n))} — ${s.about}; one of ${s.values.map((v) => JSON.stringify(v)).join(", ")}`;
  });
  return ok([which.length === 1 ? "Realm setting:" : "Realm's settings you may change:", ...lines].join("\n"));
}

async function setOne(d: SettingsDeps, ctx: ProviderCallContext, raw: unknown): Promise<CallToolResult> {
  const args = parseArgs(SettingsSetArgs, raw); if ("error" in args) return args.error;
  const { name, value } = args.value;
  if (!Object.hasOwn(AGENT_SETTINGS, name)) {
    return err(`"${name}" is not a setting you can change. These are: ${AGENT_SETTING_NAMES.join(", ")}. Anything else — permissions, sign-ins, MCP servers, notifications — is the user's to change in Settings; tell them where it is instead.`);
  }
  const s = AGENT_SETTINGS[name as AgentSettingName];
  if (!(s.values as readonly unknown[]).includes(value)) {
    return err(`${name} takes ${s.values.map((v) => JSON.stringify(v)).join(", ")} — not ${JSON.stringify(value)}.`);
  }
  const was = current(d, name as AgentSettingName);
  if (was === value) return ok(`${name} is already ${JSON.stringify(value)}.`);

  const gate = await d.broker.gate(ctx.sessionId, "settings_set", `Change Realm's ${name} from ${JSON.stringify(was)} to ${JSON.stringify(value)}`, { name, value });
  if (!gate.allowed) return err(gate.reason);
  d.settings.set(s.key, value);
  d.rpc.broadcast("settings.changed", { key: s.key, value });
  return ok(`${name} is ${JSON.stringify(value)} now (it was ${JSON.stringify(was)}). The window has it already.`);
}
