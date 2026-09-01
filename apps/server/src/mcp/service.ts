import { MCP_SECRET_STORAGE_NOTE, type ItemScope, type McpOauthStatus, type McpServer, type McpServerStatus, type McpTransport } from "@realm/contracts";
import { RpcError } from "../store/rows";
import { liveCheck, type McpTestResult } from "./live-check";
import type { SettingsStore } from "../store/settings";
import type { McpServerInput, McpServerRow, McpServersStore } from "../store/mcp";
import { readOauthState } from "./oauth";

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

/**
 * Per-space disable OVERRIDES for **inherited** (profile-scoped) servers — W2's third key, with the
 * third polarity, and deliberately so. A profile-scoped server exists because the user promoted it (or
 * defined it at the profile): that act is the opt-in the space-scope enabled-set exists to collect, so
 * inherited servers default ON and this set names the spaces that opted back out. It is a different key
 * from `enabledKey` because the two answer different questions about different scopes — folding both
 * into one set would make "never opted in" and "opted out of the profile's choice" the same stored
 * fact, and promote/demote need to tell them apart to preserve effective sets.
 */
const profileDisabledKey = (spaceId: string): string => `mcp.profileDisabled:${spaceId}`;

/** Per-space, per-server tool allowlist (W1 storage only — `mcp.setAllowedTools`/RPC wiring is W3).
 *  Absent = every cached tool allowed, which is also a server nobody has ever narrowed. */
const allowedToolsKey = (spaceId: string, serverId: string): string => `mcp.allowedTools:${spaceId}:${serverId}`;
/** The *disabled* Realm-native provider names for a space — inverted vs `enabledKey` because providers
 *  default ON; see `providerEnabled`. */
const providersDisabledKey = (spaceId: string): string => `mcp.providersDisabled:${spaceId}`;

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
  constructor(private d: {
    servers: McpServersStore; settings: SettingsStore; statusOf?: (id: string) => McpServerStatus;
    /** W2: the one slice of the spaces/profiles world this service may see, for scope resolution.
     *  Optional like `statusOf`: unwired (older tests), every space reads as profile-less, profile-
     *  scoped rows apply nowhere, and pre-scoping rows behave exactly as they did before W2. */
    scopes?: { profileIdOf(spaceId: string): string | null; spaceIdsOf(profileId: string): string[]; allSpaceIds(): string[] };
  }) {}

  private profileIdOf(spaceId: string): string | null { return this.d.scopes?.profileIdOf(spaceId) ?? null; }

  /**
   * Does this row's defining scope reach `spaceId` at all (before any enable state is consulted)?
   * Space-scoped: its own space, or every space for a pre-scoping row (`spaceId: null`) — and a
   * defining space that no longer exists degrades to the pre-scoping reading, so the row stays
   * reachable (and safely OFF everywhere, per the opt-in polarity) instead of orphaned. Profile-scoped:
   * exactly the spaces of ITS profile — never a space of any other profile; a dead profile therefore
   * applies nowhere (see the v11 migration comment).
   */
  private appliesTo(scope: ItemScope, spaceId: string): boolean {
    if (scope.kind === "profile") { const pid = this.profileIdOf(spaceId); return pid !== null && pid === scope.profileId; }
    return scope.spaceId === null || scope.spaceId === spaceId || this.profileIdOf(scope.spaceId) === null;
  }

  /** Every server, carrying this space's enable flag and tool allowlist, plus the storage note the UI
   *  must show. */
  list(spaceId: string): { servers: McpServer[]; secretNote: string } {
    const effective = new Set(this.effectiveServerIds(spaceId));
    return {
      servers: this.d.servers.list().filter((r) => this.appliesTo(r.scope, spaceId))
        .map((r) => toContract(r, effective.has(r.id), this.allowedTools(spaceId, r.id), this.statusOf(r.id))),
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

  /**
   * **The effective set** (W2) — the ONE place the profile/space scoping math for MCP servers lives.
   * Everything that answers "which servers does this space run" flows through here: `list()`'s enabled
   * flags, `isEnabled`, the gateway's `tools/list` universe and its call routing. The panels and the
   * wire are structurally unable to disagree because neither has anything else to read (the settings
   * keys are private to this file — `scoping.test.ts` enforces that with a grep).
   *
   * Effective(space) = profile-scoped servers of the space's profile MINUS its per-space disable
   * overrides (inherited items default ON), PLUS space-scoped servers in its enabled-set (space-scope
   * items keep MCP's own polarity: default OFF, opt-in — see `enabledKey`'s doc comment for why the
   * two polarities differ). Ordered as `servers.list()` orders rows, so every consumer agrees on order.
   */
  effectiveServerIds(spaceId: string): string[] {
    const enabled = new Set(readIds(this.d.settings, enabledKey(spaceId)));
    const overridden = new Set(readIds(this.d.settings, profileDisabledKey(spaceId)));
    return this.d.servers.list()
      .filter((r) => this.appliesTo(r.scope, spaceId) && (r.scope.kind === "profile" ? !overridden.has(r.id) : enabled.has(r.id)))
      .map((r) => r.id);
  }

  /**
   * Define a server. Scope is decided ONCE, here, at creation (the plan's rule 3):
   *
   * - `spaceId` given — space-scoped to that space, and enabled there (the add is the opt-in). Before
   *   W2 the row was global-with-one-enable; now the definition itself lives where it was made.
   * - `profileId` given — profile-scoped: inherited (default ON) by every space of that profile, with
   *   no per-space overrides to start.
   * - neither — a pre-scoping row (visible everywhere, enabled nowhere), which is what an import or a
   *   settings screen with no scope in view wants.
   */
  add(fields: McpServerFields & { name: string; transport: McpTransport }, spaceId: string | null, profileId: string | null = null): McpServer {
    const input = { name: fields.name, ...normalize(fields, fields.transport, blank()) };
    requireEndpoint(input);
    const scope: ItemScope = profileId ? { kind: "profile", profileId } : { kind: "space", spaceId };
    const row = this.d.servers.create(input, scope);
    if (spaceId && !profileId) this.setEnabled(spaceId, row.id, true);
    return toContract(row, profileId !== null || spaceId !== null, spaceId ? this.allowedTools(spaceId, row.id) : null, this.statusOf(row.id));
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
    this.d.servers.update(id, input);
    // Same projection `get` already computes — no reason to duplicate it here (reviewer nit).
    return this.get(id, spaceId)!;
  }

  /** Forget the server and every space's opt-in to it — and every space's inherited-disable override
   *  (W2), so re-adding the same name starts clean at either scope. */
  remove(id: string, spaceIds: readonly string[]): void {
    this.d.servers.delete(id);
    for (const spaceId of spaceIds) {
      for (const key of [enabledKey(spaceId), profileDisabledKey(spaceId)]) {
        const ids = readIds(this.d.settings, key);
        if (ids.includes(id)) this.d.settings.set(key, ids.filter((x) => x !== id));
      }
    }
  }

  /**
   * One server, through the same `toContract` projection `list` uses — `null` if it does not exist.
   *
   * The projection, not the row, deliberately: `McpServerRow` carries secret VALUES, and the plan's rule
   * is that nothing outside `hub.ts`/`oauth.ts` ever touches them. `mcp.update` needs this twice — once
   * before an edit to see where the server used to point, and once after, when clearing an OAuth
   * connection means the result it already computed has gone stale.
   */
  get(id: string, spaceId: string | null): McpServer | null {
    const row = this.d.servers.get(id);
    if (!row) return null;
    return toContract(row, spaceId !== null && this.isEnabled(spaceId, id), spaceId ? this.allowedTools(spaceId, id) : null, this.statusOf(id));
  }

  /**
   * Flip one server for one space — routed by the row's defining scope (W2), so the panels' existing
   * toggle keeps working against the new model without knowing it exists. A space-scoped row keeps the
   * opt-in enabled-set; an INHERITED (profile-scoped) row flips this space's disable override instead —
   * per-space in both directions, so a sibling space's state never moves (each space has its own key).
   * An id with no row falls through to the space-scope write: the preference-survives-the-row posture
   * `skills.setEnabled` established.
   */
  setEnabled(spaceId: string, id: string, enabled: boolean): void {
    const row = this.d.servers.get(id);
    const inherited = row?.scope.kind === "profile";
    const key = inherited ? profileDisabledKey(spaceId) : enabledKey(spaceId);
    const ids = new Set(readIds(this.d.settings, key));
    // Inherited rows store the disable set (default ON), space rows the enable set (default OFF).
    if (enabled === !inherited) ids.add(id); else ids.delete(id);
    this.d.settings.set(key, [...ids].sort());
  }

  /** Membership in `effectiveServerIds` — the same computation, asked about one id. */
  isEnabled(spaceId: string, id: string): boolean {
    return this.effectiveServerIds(spaceId).includes(id);
  }

  /**
   * Promote: move a space-scoped (or pre-scoping) server's defining scope to `spaceId`'s profile.
   *
   * **Effective-set neutral, by construction, for every space that exists right now.** For each space
   * of the profile: enabled → stays effectively on (its enabled-set entry is retired; no override);
   * not enabled → a disable override is written, because under MCP's polarity "never opted in" and
   * "off" are the same observable fact and the safe reading is off — promotion must never arm a space
   * that had not agreed to run this server. Spaces of other profiles lose the (pre-scoping) row from
   * their lists — but it was in their effective set only if enabled there, and a pre-scoping row
   * enabled elsewhere is exactly the cross-profile state promotion exists to end; their stale
   * enabled-set entries are retired too so a later demote cannot resurrect them by accident.
   * What promotion changes is the future: profile spaces created later inherit it ON.
   */
  promote(spaceId: string, id: string): void {
    const row = this.d.servers.get(id);
    if (!row) throw new RpcError("NOT_FOUND", `mcp server ${id} not found`);
    if (row.scope.kind === "profile") throw new RpcError("SCOPE_MISMATCH", `"${row.name}" is already profile-scoped`);
    if (!this.appliesTo(row.scope, spaceId)) throw new RpcError("SCOPE_MISMATCH", `"${row.name}" is not defined in this space`);
    const profileId = this.profileIdOf(spaceId);
    if (!profileId) throw new RpcError("SCOPE_MISMATCH", `space ${spaceId} has no profile to promote into`);
    const profileSpaces = new Set(this.d.scopes!.spaceIdsOf(profileId));
    for (const s of this.d.scopes!.allSpaceIds()) {
      const wasOn = readIds(this.d.settings, enabledKey(s)).includes(id);
      this.retire(enabledKey(s), id);
      if (profileSpaces.has(s) && !wasOn) this.addTo(profileDisabledKey(s), id);
    }
    this.d.servers.setScope(id, { kind: "profile", profileId });
  }

  /**
   * Demote: pin a profile-scoped server to `spaceId` alone (which must be a space of its profile).
   * This space's effective state is preserved exactly (on → enabled-set entry; overridden-off → none).
   * Sibling spaces stop seeing it — that is what "defined in this space" means — and every space's now-
   * meaningless override entry is retired. Promote→demote→promote is therefore lossy FOR SIBLINGS
   * (space scope has nowhere to remember their states), which is stated here rather than papered over.
   */
  demote(spaceId: string, id: string): void {
    const row = this.d.servers.get(id);
    if (!row) throw new RpcError("NOT_FOUND", `mcp server ${id} not found`);
    if (row.scope.kind !== "profile") throw new RpcError("SCOPE_MISMATCH", `"${row.name}" is not profile-scoped`);
    if (this.profileIdOf(spaceId) !== row.scope.profileId) throw new RpcError("SCOPE_MISMATCH", `space ${spaceId} is not in "${row.name}"'s profile`);
    const wasOn = this.isEnabled(spaceId, id);
    for (const s of this.d.scopes?.allSpaceIds() ?? [spaceId]) this.retire(profileDisabledKey(s), id);
    if (wasOn) this.addTo(enabledKey(spaceId), id);
    this.d.servers.setScope(id, { kind: "space", spaceId });
  }

  private addTo(key: string, id: string): void {
    const ids = new Set(readIds(this.d.settings, key)); ids.add(id);
    this.d.settings.set(key, [...ids].sort());
  }
  private retire(key: string, id: string): void {
    const ids = readIds(this.d.settings, key);
    if (ids.includes(id)) this.d.settings.set(key, ids.filter((x) => x !== id));
  }

  /**
   * Realm-native gateway providers (`realm-browser`) — per-space disableable like any server, but
   * default ON where server rows default OFF, so the settings key stores the *disabled* set (the
   * skills rationale, not the servers one: a provider is Realm's own code operating under Realm's own
   * permission flow, not a process or URL the user configured — presence in the product IS the opt-in,
   * and the per-space switch exists to turn it off).
   */
  providerEnabled(spaceId: string, name: string): boolean {
    return !readIds(this.d.settings, providersDisabledKey(spaceId)).includes(name);
  }

  setProviderEnabled(spaceId: string, name: string, enabled: boolean): void {
    const key = providersDisabledKey(spaceId);
    const names = new Set(readIds(this.d.settings, key));
    if (enabled) names.delete(name); else names.add(name);
    this.d.settings.set(key, [...names].sort());
  }

  /**
   * `mcp.test` — connect to the server right now and report reached/failed. The row's secrets go INTO
   * the connection (env / headers), exactly as a session start would send them; the result carries a
   * sentence, never a value. See live-check.ts for why this is honest where definition-time validation
   * is not.
   *
   * Dials the upstream server directly rather than going through the hub, on purpose: `statusOf` below
   * is the hub's steady-state readout, and this is the probe a user reaches for precisely when that
   * readout is unhappy. A hub connection that is already `circuit_open` would fail fast and tell them
   * nothing about the row they just edited.
   */
  test(id: string): Promise<McpTestResult> {
    const row = this.d.servers.get(id);
    if (!row) throw new RpcError("NOT_FOUND", `mcp server ${id} not found`);
    return liveCheck(row);
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
 * `statusOf` doc comment). `oauthStatus` is `oauthStatusOf`'s three-state read of the same column.
 *
 * `authKind` deliberately keys on the column being NON-EMPTY rather than on the parsed state, so it
 * answers a different question than `oauthStatus`: which auth mechanism this server uses, not whether it
 * currently works. A row whose refresh failed, whose flow was abandoned, or whose blob went corrupt all
 * still report `"oauth"` — which is what makes the settings UI show a Connect button (the thing that
 * fixes all three) instead of falling back to the API-key form.
 */
function toContract(r: McpServerRow, enabled: boolean, allowedTools: string[] | null, status: McpServerStatus): McpServer {
  const keys = Object.keys(r.secrets).sort();
  return {
    id: r.id, name: r.name, transport: r.transport, scope: r.scope,
    command: r.command, args: r.args, url: r.url,
    envKeys: r.transport === "stdio" ? keys : [],
    headerKeys: r.transport === "stdio" ? [] : keys,
    // Oauth beats secrets beats none: a row can carry both a leftover header key and a completed OAuth
    // connection (e.g. after switching a server from an API key to OAuth), and OAuth is what the hub
    // actually sends upstream once it exists.
    authKind: r.oauthJson ? "oauth" : keys.length > 0 ? "secrets" : "none",
    oauthStatus: oauthStatusOf(r),
    status,
    tools: r.tools,
    allowedTools,
    enabled, createdAt: r.createdAt,
  };
}

/**
 * `oauthJson` → the three-state enum a client sees. The ONE derivation site.
 *
 * - Nothing stored (or an unreadable blob — `readOauthState` degrades corruption to empty rather than
 *   throwing) → `unconfigured`.
 * - The refresh-failed flag set → `reconnect_needed`, checked FIRST: such a row still holds its (now
 *   useless) tokens, and reporting it `connected` would badge a server that cannot make a single call.
 * - Otherwise, tokens present → `connected`.
 *
 * A row with a PENDING flow but no tokens stays `unconfigured`: the user clicked Connect and never came
 * back from the browser, which is exactly "not connected". Only a completed callback flips it.
 *
 * Exported (rather than kept private to `toContract`) so `app.ts`'s status callbacks — which broadcast
 * `mcp.serverStatus` independently of `list()`/`toContract`, since a status flip can happen between
 * `mcp.list` calls — derive `oauthStatus` the SAME way instead of keeping a second copy.
 */
export function oauthStatusOf(row: McpServerRow): McpOauthStatus {
  const state = readOauthState(row.oauthJson);
  if (state.reconnectNeeded) return "reconnect_needed";
  return state.tokens ? "connected" : "unconfigured";
}
