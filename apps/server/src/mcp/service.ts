import { MCP_SECRET_STORAGE_NOTE, type McpServer, type McpTransport } from "@realm/contracts";
import type { McpServerConfig } from "@realm/adapters";
import { RpcError } from "../store/rows";
import type { SettingsStore } from "../store/settings";
import type { McpServerInput, McpServerRow, McpServersStore } from "../store/mcp";

/**
 * Per-space **enabled** ids — the opposite of W1's skills key, and deliberately so.
 *
 * Skills store the *disabled* set because a folder the user drops a `SKILL.md` into should work at
 * once, and the cost of being wrong is a paragraph of text the agent might read. An MCP server is a
 * process Realm spawns, or a URL Realm sends an API key to. A server added while configuring a Work
 * space must not quietly arm itself in a School space where the user never agreed to run it. So the
 * default is off, and a space's set names what it opted into.
 */
const enabledKey = (spaceId: string): string => `mcp.enabled:${spaceId}`;

/** Per-space, per-server tool allowlist (W1 storage only — `mcp.setAllowedTools`/RPC wiring is W3).
 *  Absent = every cached tool allowed, which is also a server nobody has ever narrowed. */
const allowedToolsKey = (spaceId: string, serverId: string): string => `mcp.allowedTools:${spaceId}:${serverId}`;

const readIds = (settings: SettingsStore, key: string): string[] => {
  const v = settings.get(key);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

/** What `mcp.add` / `mcp.update` accept, before the transport decides which half of it is meaningful. */
export type McpServerFields = {
  name?: string; transport?: McpTransport;
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string; headers?: Record<string, string>;
};

/**
 * Realm's MCP server definitions, and which spaces use them.
 *
 * The one rule that shapes this class: **secret values go out exactly one way** — through
 * `configFor`, into a session's `StartOptions`, to the adapter that was configured to receive them.
 * `list` returns key names. Nothing here logs, broadcasts, or returns a value.
 */
export class McpService {
  constructor(private d: { servers: McpServersStore; settings: SettingsStore }) {}

  /** Every server, carrying this space's enable flag and tool allowlist, plus the storage note the UI
   *  must show. */
  list(spaceId: string): { servers: McpServer[]; secretNote: string } {
    const enabled = new Set(readIds(this.d.settings, enabledKey(spaceId)));
    return {
      servers: this.d.servers.list().map((r) => toContract(r, enabled.has(r.id), this.allowedTools(spaceId, r.id))),
      secretNote: MCP_SECRET_STORAGE_NOTE,
    };
  }

  /** This space's per-tool allowlist for one server. `null` = every cached tool allowed — both for a
   *  server nobody has narrowed and for one whose space was never given (add/update with `spaceId:
   *  null`, where there is no per-space state to read). Storage only in W1; `mcp.setAllowedTools`
   *  (W3) is what ever writes `allowedToolsKey`. */
  allowedTools(spaceId: string, id: string): string[] | null {
    const v = this.d.settings.get(allowedToolsKey(spaceId, id));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  }

  /**
   * Define a server, and enable it in the space it was added from — and nowhere else.
   *
   * `spaceId: null` adds it enabled nowhere, which is what an import or a settings screen with no
   * space in scope wants.
   */
  add(fields: McpServerFields & { name: string; transport: McpTransport }, spaceId: string | null): McpServer {
    const input = { name: fields.name, ...normalize(fields, fields.transport, blank()) };
    requireEndpoint(input);
    const row = this.d.servers.create(input);
    if (spaceId) this.setEnabled(spaceId, row.id, true);
    return toContract(row, spaceId !== null, spaceId ? this.allowedTools(spaceId, row.id) : null);
  }

  /**
   * Change a server in place. An omitted field keeps its stored value — including `env`/`headers`,
   * which a client cannot round-trip because it was never given them.
   *
   * Changing the transport re-reads the fields for the NEW transport from `fields` alone: a stdio
   * server turned into an HTTP one must not keep a `command` that would then be dead state, nor an
   * `env` map whose keys mean nothing as headers. Nothing is carried across the switch.
   */
  update(id: string, fields: McpServerFields, spaceId: string | null = null): McpServer {
    const existing = this.d.servers.get(id);
    if (!existing) throw new RpcError("NOT_FOUND", `mcp server ${id} not found`);
    const transport = fields.transport ?? existing.transport;
    const base = transport === existing.transport ? existing : blank();
    const input = { name: fields.name ?? existing.name, ...normalize(fields, transport, base) };
    requireEndpoint(input);
    const row = this.d.servers.update(id, input);
    return toContract(row, spaceId !== null && this.isEnabled(spaceId, id), spaceId ? this.allowedTools(spaceId, id) : null);
  }

  /** Forget the server and every space's opt-in to it, so re-adding the same name starts clean. */
  remove(id: string, spaceIds: readonly string[]): void {
    this.d.servers.delete(id);
    for (const spaceId of spaceIds) {
      const key = enabledKey(spaceId);
      const ids = readIds(this.d.settings, key);
      if (ids.includes(id)) this.d.settings.set(key, ids.filter((x) => x !== id));
    }
  }

  setEnabled(spaceId: string, id: string, enabled: boolean): void {
    const key = enabledKey(spaceId);
    const ids = new Set(readIds(this.d.settings, key));
    if (enabled) ids.add(id); else ids.delete(id);
    this.d.settings.set(key, [...ids].sort());
  }

  isEnabled(spaceId: string, id: string): boolean {
    return readIds(this.d.settings, enabledKey(spaceId)).includes(id);
  }

  /**
   * This space's enabled servers, secrets included, for one session's `StartOptions`.
   *
   * The **only** path a secret value takes out of the database. Deliberately not called anywhere that
   * broadcasts, persists, or logs: `SessionService` passes the result straight to `adapter.start`.
   *
   * Transport filtering is NOT done here. Each adapter drops what its agent cannot reach and says which
   * and why through `onLog` — one place that knows the wire, rather than two that can disagree.
   *
   * Never throws. An unreadable definition costs a session one tool server; it does not cost the user
   * their session.
   */
  configFor(spaceId: string): McpServerConfig[] {
    try {
      const enabled = new Set(readIds(this.d.settings, enabledKey(spaceId)));
      return this.d.servers.list().filter((r) => enabled.has(r.id)).flatMap(toAdapterConfig);
    } catch (e) {
      console.error(`[mcp] could not resolve servers for space ${spaceId}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }
}

/**
 * A server with no command (stdio) or no URL (http/sse) cannot connect to anything, so it is refused at
 * the point of definition rather than stored and skipped at session start. "Saved, listed, and silently
 * dead" is the exact failure this workstream exists to prevent — and `configFor` drops such a row, so
 * without this the user would see it in the list and never in the agent.
 */
function requireEndpoint(input: McpServerInput): void {
  if (input.transport === "stdio" ? !input.command : !input.url) {
    throw new RpcError("MCP_INCOMPLETE", input.transport === "stdio"
      ? "a stdio MCP server needs a command"
      : `a ${input.transport} MCP server needs a url`);
  }
}

/** The fields a server has when nothing has been said about it yet. A fresh object each call: the
 *  caller writes into it, and a shared `args`/`secrets` would leak between two servers. */
const blank = (): Omit<McpServerInput, "name" | "transport"> => ({ command: "", args: [], url: "", secrets: {} });

/** `McpServerFields` → the store's shape, reading only the half that this transport uses. */
function normalize(f: McpServerFields, transport: McpTransport, base: Omit<McpServerInput, "name" | "transport">): Omit<McpServerInput, "name"> {
  return transport === "stdio"
    ? { transport, command: f.command ?? base.command, args: f.args ?? base.args, url: "", secrets: f.env ?? base.secrets }
    : { transport, command: "", args: [], url: f.url ?? base.url, secrets: f.headers ?? base.secrets };
}

/**
 * Row → wire. **The projection that keeps secrets off every client surface**: `secrets` becomes
 * `envKeys` or `headerKeys`, and `oauthJson` becomes `oauthStatus` — the values of neither are carried.
 *
 * `status` is always `"idle"` here: the hub that would report `connected`/`error`/`circuit_open`
 * doesn't exist until W2. `oauthStatus` is the coarse W1 read of `oauthJson` — `""` means OAuth has
 * never completed, anything else means it has; the `reconnect_needed` state needs the hub's refresh
 * logic (W5) to ever be produced.
 */
function toContract(r: McpServerRow, enabled: boolean, allowedTools: string[] | null): McpServer {
  const keys = Object.keys(r.secrets).sort();
  return {
    id: r.id, name: r.name, transport: r.transport,
    command: r.command, args: r.args, url: r.url,
    envKeys: r.transport === "stdio" ? keys : [],
    headerKeys: r.transport === "stdio" ? [] : keys,
    // Oauth beats secrets beats none: a row can carry both a leftover header key and a completed OAuth
    // connection (e.g. after switching a server from an API key to OAuth), and OAuth is what the hub
    // actually sends upstream once it exists.
    authKind: r.oauthJson ? "oauth" : keys.length > 0 ? "secrets" : "none",
    oauthStatus: r.oauthJson ? "connected" : "unconfigured",
    status: "idle",
    tools: r.tools,
    allowedTools,
    enabled, createdAt: r.createdAt,
  };
}

/**
 * Row → adapter. Returns `[]` for a definition that cannot connect — a stdio row with no command, a
 * remote row with no URL. Passing one on would spawn nothing and look configured.
 */
function toAdapterConfig(r: McpServerRow): McpServerConfig[] {
  if (r.transport === "stdio") {
    if (!r.command) return [];
    return [{ name: r.name, transport: "stdio", command: r.command, args: r.args, env: r.secrets }];
  }
  if (!r.url) return [];
  return [{ name: r.name, transport: r.transport, url: r.url, headers: r.secrets }];
}
