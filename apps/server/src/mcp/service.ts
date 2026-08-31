import { MCP_SECRET_STORAGE_NOTE, type McpServer, type McpServerStatus, type McpTransport } from "@realm/contracts";
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
 * Secrets discipline is now `hub.ts`'s alone (W3): the passthrough that used to hand `configFor`'s
 * output straight to an adapter is gone, and nothing in this file ever reads `McpServerRow.secrets` or
 * `oauthJson` again. `list` returns key names. Nothing here logs, broadcasts, or returns a secret value.
 */
export class McpService {
  /** `statusOf` is the hub's live connection state, injected rather than imported: `McpService` has no
   *  business knowing `McpHub` exists, and a caller that doesn't wire one (older tests, a stripped
   *  harness) gets the W1-era "always idle" behavior for free. Wired for real in `app.ts` from the hub's
   *  own `onStatus` cache. */
  constructor(private d: { servers: McpServersStore; settings: SettingsStore; statusOf?: (id: string) => McpServerStatus }) {}

  /** Every server, carrying this space's enable flag and tool allowlist, plus the storage note the UI
   *  must show. */
  list(spaceId: string): { servers: McpServer[]; secretNote: string } {
    const enabled = new Set(readIds(this.d.settings, enabledKey(spaceId)));
    return {
      servers: this.d.servers.list().map((r) => toContract(r, enabled.has(r.id), this.allowedTools(spaceId, r.id), this.statusOf(r.id))),
      secretNote: MCP_SECRET_STORAGE_NOTE,
    };
  }

  /** This space's per-tool allowlist for one server. `null` = every cached tool allowed — both for a
   *  server nobody has narrowed and for one whose space was never given (add/update with `spaceId:
   *  null`, where there is no per-space state to read), AND for a corrupted stored value (see
   *  `setAllowedTools`'s doc comment: Realm writes this key itself, so a non-array here is a bug, not an
   *  attacker, and failing open is the graceful-degradation call the W1 review made explicit). */
  allowedTools(spaceId: string, id: string): string[] | null {
    const v = this.d.settings.get(allowedToolsKey(spaceId, id));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  }

  /**
   * Narrow (or reset) this space's tool allowlist for one server. `tools: null` restores "every cached
   * tool allowed" — the same default a server nobody has touched already has, per `allowedTools`'s
   * fail-open reading of a missing/corrupt key.
   */
  setAllowedTools(spaceId: string, id: string, tools: string[] | null): void {
    this.d.settings.set(allowedToolsKey(spaceId, id), tools);
  }

  /** ids of the servers this space has opted into — the gateway's `tools/list` universe. Same enabled
   *  set `list()` reads, exposed directly so the gateway isn't forced through a full `McpServer[]`
   *  projection just to learn which ids to ask the hub about. */
  enabledServerIds(spaceId: string): string[] {
    return readIds(this.d.settings, enabledKey(spaceId));
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
    return toContract(row, spaceId !== null, spaceId ? this.allowedTools(spaceId, row.id) : null, this.statusOf(row.id));
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
    return toContract(row, spaceId !== null && this.isEnabled(spaceId, id), spaceId ? this.allowedTools(spaceId, id) : null, this.statusOf(row.id));
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

  private statusOf(id: string): McpServerStatus {
    return (this.d.statusOf ?? (() => "idle" as const))(id);
  }
}

/**
 * A server with no command (stdio) or no URL (http/sse) cannot connect to anything, so it is refused at
 * the point of definition rather than stored and skipped at connect time. "Saved, listed, and silently
 * dead" is the exact failure this workstream exists to prevent — `hub.ts`'s `buildTransport` has nothing
 * that would catch it, so without this the user would see the row in the list and never a working tool.
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
 * `status` is the hub's live connection state, handed in rather than read here (see the constructor's
 * `statusOf` doc comment). `oauthStatus` is the coarse W1 read of `oauthJson` — `""` means OAuth has
 * never completed, anything else means it has; the `reconnect_needed` state needs the hub's refresh
 * logic (W5) to ever be produced.
 */
function toContract(r: McpServerRow, enabled: boolean, allowedTools: string[] | null, status: McpServerStatus): McpServer {
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
    status,
    tools: r.tools,
    allowedTools,
    enabled, createdAt: r.createdAt,
  };
}
