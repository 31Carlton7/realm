import { Methods, type MethodName, type MethodResult } from "@realm/contracts";
import type { z } from "zod";
import type { RpcServer } from "./server";
import type { ProfilesStore } from "../store/profiles";
import type { SpacesStore } from "../store/spaces";
import type { IconAssetsStore } from "../store/icon-assets";
import type { IconGenerationService } from "../icons/service";
import type { ProjectsStore } from "../store/projects";
import type { EnvironmentsStore } from "../store/environments";
import type { EnvironmentService } from "../environments/service";
import type { CheckpointService } from "../checkpoints/service";
import type { ItemsStore } from "../store/items";
import type { SettingsStore } from "../store/settings";
import type { SkillsService } from "../skills/service";
import type { McpService } from "../mcp/service";
import type { McpHub } from "../mcp/hub";
import type { McpGateway } from "../mcp/gateway";
import type { McpOauth } from "../mcp/oauth";
import type { McpCallLogStore } from "../store/mcp";
import type { MemoryService } from "../memory/service";
import type { TerminalService } from "../terminals/service";
import type { BrowserService } from "../browsers/service";
import type { BrowserHostBridge } from "../browsers/host-bridge";
import type { SessionService } from "../sessions/service";
import type { NotificationsService } from "../notifications/service";
import type { ReviewService } from "../delegation/review";
import type { SearchService } from "../search/service";
import type { ForkService } from "../sessions/fork";
import type { ImportService } from "../import/service";
import type { GitInfoService } from "../workspace/git-info";
import type { GitDiffService } from "../workspace/git-diff";
import type { GitWriteService } from "../workspace/git-write";
import type { ShipsStore } from "../store/ships";
import type { PortAllocator } from "../workspace/ports";
import { NotFoundError, RpcError } from "../store/rows";

/** Parsed (post-default) params, i.e. what the handler actually receives. */
type Params<M extends MethodName> = z.infer<(typeof Methods)[M]["params"]>;
type Result<M extends MethodName> = MethodResult<M> | Promise<MethodResult<M>>;

export type Deps = {
  rpc: RpcServer; home: string; version: string; machineName: string;
  profiles: ProfilesStore; spaces: SpacesStore; projects: ProjectsStore; environments: EnvironmentsStore; envService: EnvironmentService; items: ItemsStore; settings: SettingsStore; skills: SkillsService; mcp: McpService; hub: McpHub; gateway: McpGateway; oauth: McpOauth; calls: McpCallLogStore; memory: MemoryService; terminals: TerminalService; browsers: BrowserService; browserBridge: BrowserHostBridge; sessions: SessionService; gitInfo: GitInfoService; gitDiff: GitDiffService; gitWrite: GitWriteService; ships: ShipsStore; ports: PortAllocator; checkpoints: CheckpointService; notifications: NotificationsService; reviews: ReviewService; search: SearchService; forks: ForkService; imports: ImportService;
  iconAssets: IconAssetsStore; iconGeneration: IconGenerationService;
};

export function registerMethods(d: Deps): void {
  const { rpc } = d;
  const reg = <M extends MethodName>(name: M, fn: (p: Params<M>) => Result<M>) =>
    rpc.register(name, Methods[name].params, async (p) => fn(p as Params<M>));

  reg("system.info", () => ({ realmHome: d.home, version: d.version, machineName: d.machineName }));

  reg("workspace.gitInfo", (p) => d.gitInfo.get(p.cwd));
  reg("workspace.diff", (p) => d.gitDiff.summary(p.cwd));
  reg("workspace.fileDiff", (p) => d.gitDiff.file(p.cwd, p.path, p.staged));
  // Realm just changed this working tree, so the numbers `workspace.gitInfo` is holding for it are
  // wrong. Invalidating here (rather than trusting the 3s TTL) is what makes the composer's chips
  // and the diff pane agree the moment an action finishes.
  const changed = (cwd: string) => { d.gitInfo.invalidate(cwd); rpc.broadcast("workspace.changed", { cwd }); };
  reg("workspace.stage", async (p) => { await d.gitWrite.stage(p.cwd, p.paths); changed(p.cwd); return { ok: true as const }; });
  reg("workspace.unstage", async (p) => { await d.gitWrite.unstage(p.cwd, p.paths); changed(p.cwd); return { ok: true as const }; });
  reg("workspace.ship", async (p) => {
    // Ship-log attribution (Plan 14 W1): the pane NAMES its environment; the row records that checkout
    // and that checkout's space, never a path-guess (a path can be registered in two spaces). The named
    // environment must actually be the checkout being shipped — a mismatch would file the row under a
    // different tree than the one the commit landed in, so it is refused, not silently mis-logged.
    let log: { environmentId: string; spaceId: string } | null = null;
    if (p.environmentId !== null) {
      const env = d.environments.get(p.environmentId);
      if (!env) throw new NotFoundError("environment", p.environmentId);
      if (env.path !== p.cwd) throw new RpcError("ENVIRONMENT_MISMATCH", `environment ${p.environmentId} is at ${env.path}, not ${p.cwd}`);
      log = { environmentId: env.id, spaceId: env.spaceId };
    }
    const result = await d.gitWrite.ship({ ...p, log });
    // Broadcast even when a step reported a problem: a commit that succeeded before a push that was
    // rejected still moved the tree, and the pane must show that.
    changed(p.cwd);
    // A commit that landed makes any persisted review verdict describe a diff that no longer exists
    // (Plan 13 W3's staleness rule). Note the direction — ship clears review; nothing ever wires
    // review→ship, which is the banned direction.
    if (result.commit.state === "committed") d.reviews.shipped(p.cwd);
    return result;
  });
  // The durable ship log (Plan 14 W1). Space-checked like every per-space listing: a typo'd id should
  // say so, not answer an empty page for a space that is not there.
  reg("ships.list", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    return d.ships.list(p);
  });

  reg("profiles.list", () => d.profiles.list());
  reg("profiles.create", (p) => { const r = d.profiles.create(p); rpc.broadcast("profiles.changed", {}); return r; });
  reg("profiles.update", (p) => { const r = d.profiles.update(p); rpc.broadcast("profiles.changed", {}); return r; });
  reg("profiles.delete", (p) => { d.profiles.delete(p.id); rpc.broadcast("profiles.changed", {}); return { ok: true as const }; });

  reg("spaces.list", () => d.spaces.listAll());
  reg("spaces.create", (p) => { const r = d.spaces.create(p); rpc.broadcast("spaces.changed", {}); return r; });
  reg("spaces.update", (p) => { const r = d.spaces.update(p); rpc.broadcast("spaces.changed", {}); return r; });
  reg("spaces.reorder", (p) => { d.spaces.reorder(p.ids); rpc.broadcast("spaces.changed", {}); return { ok: true as const }; });
  reg("spaces.setLayout", (p) => { const r = d.spaces.setLayout(p.id, p.layout); rpc.broadcast("spaces.changed", {}); return r; });
  reg("spaces.setGroups", (p) => { const r = d.spaces.setGroups(p.id, p.groups); rpc.broadcast("spaces.changed", {}); return r; });
  reg("spaces.delete", async (p) => {
    if (d.spaces.get(p.id)) { d.terminals.closeAllInSpace(p.id); await d.sessions.deleteAllInSpace(p.id); }
    d.spaces.delete(p.id);
    rpc.broadcast("spaces.changed", {});
    return { ok: true as const };
  });

  // The space icon picker's "Generated"/"Uploaded" library — per-profile, reusable across spaces.
  reg("iconAssets.list", (p) => d.iconAssets.list(p.profileId));
  reg("iconAssets.generate", (p) => d.iconGeneration.generate(p.profileId, p.prompt));
  reg("iconAssets.upload", (p) => d.iconGeneration.upload(p.profileId, p.path));
  reg("iconAssets.delete", (p) => { d.iconAssets.delete(p.id); return { ok: true as const }; });

  reg("settings.get", (p) => ({ value: d.settings.get(p.key) }));
  reg("settings.set", (p) => { d.settings.set(p.key, p.value); return { ok: true as const }; });

  // Both check the space exists: the enabled set is keyed by space id, so a typo would silently read and
  // write preferences for a space that is not there rather than saying so.
  reg("skills.list", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    return d.skills.list(p.spaceId);
  });
  reg("skills.setEnabled", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    d.skills.setEnabled(p.spaceId, p.id, p.enabled);
    rpc.broadcast("skills.changed", { spaceId: p.spaceId });
    return { ok: true as const };
  });
  // Promote/demote change which spaces SEE the skill (a pre-scoping skill leaves other profiles'
  // lists; a demoted one leaves the siblings'), so every space's panel is told, not just the actor's.
  const skillsScopeChanged = () => { for (const sp of d.spaces.listAll()) rpc.broadcast("skills.changed", { spaceId: sp.id }); };
  reg("skills.promote", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    d.skills.promote(p.spaceId, p.id);
    skillsScopeChanged();
    return { ok: true as const };
  });
  reg("skills.demote", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    d.skills.demote(p.spaceId, p.id);
    skillsScopeChanged();
    return { ok: true as const };
  });

  // Every one of these checks the space exists first, for the same reason the skills pair does: the
  // enable set is keyed by space id, so a typo would silently read and write preferences for a space
  // that is not there rather than saying so.
  reg("mcp.list", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    return d.mcp.list(p.spaceId);
  });
  reg("mcp.add", (p) => {
    // Scope is decided once, at creation (the plan's rule 3) — so it has to be ONE scope.
    if (p.spaceId !== null && p.profileId !== null) throw new RpcError("SCOPE_MISMATCH", "pass spaceId or profileId, not both");
    if (p.spaceId !== null && !d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    if (p.profileId !== null && !d.profiles.get(p.profileId)) throw new NotFoundError("profile", p.profileId);
    const server = d.mcp.add(p, p.spaceId, p.profileId);
    // A new space-scoped server is enabled ONLY in the space it was added from (`McpService.add`'s own
    // doc comment) — but a live session already running in exactly that space needs to see it show up
    // without a restart. A profile-scoped one arms every space of the profile (default ON), so every
    // one of them is told. This is the add-server flow W6's settings UI drives end to end.
    if (p.spaceId) d.gateway.notifyPolicyChanged(p.spaceId);
    if (p.profileId) for (const sp of d.spaces.list(p.profileId)) d.gateway.notifyPolicyChanged(sp.id);
    rpc.broadcast("mcp.changed", {});
    return server;
  });
  reg("mcp.update", (p) => {
    if (p.spaceId !== null && !d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    // Read BEFORE the update: only the pre-edit values say where this server used to point, and an OAuth
    // connection is bound to the endpoint it was granted for.
    const before = d.mcp.get(p.id, p.spaceId);
    let server = d.mcp.update(p.id, p, p.spaceId);
    // A URL or transport change invalidates the row's OAuth connection outright — the tokens were minted
    // for the OLD resource. Keeping them would send a credential valid for server A to server B on
    // nothing more than a settings typo, and a switch to stdio would leave `authKind` reading "oauth"
    // behind a Connect button that can only error. Cleared BEFORE `hub.invalidate` below, so the hub's
    // next connect reads a row with no stale Bearer on it.
    //
    // ANY change counts, not just a cross-origin one: comparing origins would still let a path edit keep
    // tokens scoped to a different RFC 8707 resource, and the cost of over-clearing is one Connect click
    // on an edit the user was already making deliberately. Done after the update rather than before, so
    // an edit that gets REFUSED (a name clash, an incomplete definition) cannot cost a working
    // connection.
    if (before && before.authKind === "oauth" && (before.url !== server.url || before.transport !== server.transport)) {
      d.oauth.disconnect(p.id);
      // Re-project: the result computed a moment ago still advertises the connection just dropped.
      server = d.mcp.get(p.id, p.spaceId) ?? server;
    }
    // A renamed command, a rotated key, a URL that no longer exists — nothing may keep serving through
    // the hub's now-stale client, and every session in a space that had this server enabled must re-list
    // rather than keep whatever `tools/list` last returned before the edit.
    d.hub.invalidate(p.id);
    for (const s of d.spaces.listAll()) if (d.mcp.isEnabled(s.id, p.id)) d.gateway.notifyPolicyChanged(s.id);
    rpc.broadcast("mcp.changed", {});
    return server;
  });
  reg("mcp.remove", (p) => {
    // Computed BEFORE `d.mcp.remove` clears every space's enabled set — there is nothing left to read
    // afterward, and a space that had this server enabled is exactly the set that needs to re-list.
    const spaceIds = d.spaces.listAll().map((s) => s.id);
    const enabledIn = spaceIds.filter((sid) => d.mcp.isEnabled(sid, p.id));
    d.mcp.remove(p.id, spaceIds);
    d.hub.invalidate(p.id);
    for (const sid of enabledIn) d.gateway.notifyPolicyChanged(sid);
    rpc.broadcast("mcp.changed", {});
    return { ok: true as const };
  });
  // No broadcast and no write: a probe, not a mutation.
  reg("mcp.test", (p) => d.mcp.test(p.id));
  reg("mcp.setEnabled", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    d.mcp.setEnabled(p.spaceId, p.id, p.enabled);
    d.gateway.notifyPolicyChanged(p.spaceId);
    rpc.broadcast("mcp.changed", {});
    return { ok: true as const };
  });
  // Promote is effective-set neutral and demote strips siblings (`McpService.promote`/`demote` doc
  // comments), but visibility moves for every space of the profile either way — and a pre-scoping row
  // leaves other profiles' lists on promote — so every space re-lists and every session is nudged.
  const mcpScopeChanged = () => {
    for (const sp of d.spaces.listAll()) d.gateway.notifyPolicyChanged(sp.id);
    rpc.broadcast("mcp.changed", {});
  };
  reg("mcp.promote", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    d.mcp.promote(p.spaceId, p.id);
    mcpScopeChanged();
    return { ok: true as const };
  });
  reg("mcp.demote", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    d.mcp.demote(p.spaceId, p.id);
    mcpScopeChanged();
    return { ok: true as const };
  });
  /** Realm-native gateway providers (`realm-browser`): default ON, per-space off switch. Same
   *  policy-change plumbing as `mcp.setEnabled` — connected sessions re-list. */
  /** The gateway's registered providers with this space's switch state (W4) — names from the code
   *  registry, `enabled` from McpService's per-space disable set (default ON). */
  reg("mcp.providers.list", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    return { providers: d.gateway.providerNames().map((name) => ({ name, enabled: d.mcp.providerEnabled(p.spaceId, name) })) };
  });
  reg("mcp.setProviderEnabled", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    d.mcp.setProviderEnabled(p.spaceId, p.name, p.enabled);
    d.gateway.notifyPolicyChanged(p.spaceId);
    rpc.broadcast("mcp.changed", {});
    return { ok: true as const };
  });
  /** Triggers the hub's lazy connect. A connect failure is a RESULT (`error` naming what went wrong),
   *  never a thrown RPC error — `mcp.tools.list` must stay a renderable result even for a dead server;
   *  see `McpHub.tools()`'s own doc comment for why the hub itself throws and this layer is what catches
   *  it. On success the fresh tools (the hub just re-cached them on the row) are returned directly. */
  reg("mcp.tools.list", async (p) => {
    // Projected to the contract's name+description: the hub's live list carries inputSchema for the
    // GATEWAY's re-export, but the wire contract (and the settings UI) never declared or needed it.
    try { return { tools: (await d.hub.tools(p.id)).map((t) => ({ name: t.name, description: t.description })), error: null }; }
    catch (e) { return { tools: [], error: e instanceof Error ? e.message : String(e) }; }
  });
  reg("mcp.setAllowedTools", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    d.mcp.setAllowedTools(p.spaceId, p.id, p.tools);
    d.gateway.notifyPolicyChanged(p.spaceId);
    rpc.broadcast("mcp.changed", {});
    return { ok: true as const };
  });
  reg("mcp.calls.list", (p) => ({ calls: d.calls.list(p) }));
  /** Returns the authorization URL and nothing else — the RENDERER opens it in the system browser, and
   *  the redirect comes back to the gateway's own `/oauth/callback`, never through RPC. Every state
   *  change from here on is announced by `mcp.serverStatus`, not by this call's result. */
  reg("mcp.oauth.start", async (p) => {
    const started = await d.oauth.start(p.id);
    // The row now carries a client registration and a pending flow, so `authKind` reads `"oauth"` even
    // though `oauthStatus` is still `unconfigured` — the settings list has to re-read to show that.
    rpc.broadcast("mcp.changed", {});
    return started;
  });
  reg("mcp.oauth.disconnect", (p) => {
    // `McpOauth.disconnect` clears the row's state and fires its status callback, which is what
    // invalidates the hub client still holding the revoked Bearer and broadcasts the new `oauthStatus`.
    // `mcp.changed` on top of that is for the settings list itself (`authKind` flips back too).
    d.oauth.disconnect(p.id);
    rpc.broadcast("mcp.changed", {});
    return { ok: true as const };
  });
  reg("mcp.retry", async (p) => { await d.hub.retry(p.id); rpc.broadcast("mcp.changed", {}); return { ok: true as const }; });

  // Space existence is checked for the same reason the skills and mcp handlers do it: the memory doc,
  // its settings flag and the AGENTS.md target are all keyed by space id, so a typo would silently
  // read and write another space's memory rather than saying so.
  reg("memory.get", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    return d.memory.state(p.spaceId);
  });
  reg("memory.set", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    const r = d.memory.set(p.spaceId, p.doc);
    rpc.broadcast("memory.changed", { spaceId: p.spaceId });
    return r;
  });
  reg("memory.setAgentsFile", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    const r = d.memory.setAgentsFile(p.spaceId, p.enabled);
    rpc.broadcast("memory.changed", { spaceId: p.spaceId });
    return r;
  });
  // The PROFILE doc (W2): read anywhere, edited only at its defining scope. A profile-doc edit reaches
  // every space of the profile, so each of their panels is told.
  reg("memory.getProfile", (p) => {
    if (!d.profiles.get(p.profileId)) throw new NotFoundError("profile", p.profileId);
    return d.memory.profileState(p.profileId);
  });
  reg("memory.setProfile", (p) => {
    if (!d.profiles.get(p.profileId)) throw new NotFoundError("profile", p.profileId);
    const r = d.memory.setProfile(p.profileId, p.doc);
    for (const sp of d.spaces.list(p.profileId)) rpc.broadcast("memory.changed", { spaceId: sp.id });
    return r;
  });
  reg("memory.setProfileDocEnabled", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    const r = d.memory.setProfileDocEnabled(p.spaceId, p.enabled);
    rpc.broadcast("memory.changed", { spaceId: p.spaceId });
    return r;
  });
  // Per-session on purpose: the SessionService joins the session row (agent kind, space, cwd) to the
  // ground truth that belongs to that session and no other.
  reg("memory.sources", (p) => d.sessions.memorySources(p.sessionId));

  reg("projects.list", (p) => d.projects.list(p.spaceId));
  reg("projects.create", (p) => { const r = d.projects.create(p); rpc.broadcast("items.changed", { spaceId: r.spaceId }); return r; });
  reg("projects.delete", (p) => { const pr = d.projects.get(p.id); d.projects.delete(p.id); if (pr) rpc.broadcast("items.changed", { spaceId: pr.spaceId }); return { ok: true as const }; });

  reg("environments.list", (p) => d.environments.list(p.spaceId));
  reg("environments.get", (p) => { const e = d.environments.get(p.id); if (!e) throw new NotFoundError("environment", p.id); return e; });
  reg("environments.delete", (p) => {
    // Forgetting the row of a worktree Realm made would strand the directory and its branch on disk,
    // reachable only through `git worktree list` and no longer removable by `removeWorktree` — which
    // needs the row to know where to look. Row and directory go together or not at all.
    const env = d.environments.get(p.id);
    if (env?.kind === "worktree") throw new RpcError("ENVIRONMENT_IS_WORKTREE", "Realm made this worktree; use environments.removeWorktree so the directory goes too");
    d.environments.delete(p.id);
    return { ok: true as const };
  });
  reg("environments.createWorktree", async (p) => {
    const env = await d.envService.createWorktree(p);
    rpc.broadcast("environments.changed", { spaceId: p.spaceId });
    return env;
  });
  reg("environments.worktreeStatus", (p) => d.envService.worktreeStatus(p.id));
  reg("environments.removeWorktree", async (p) => {
    const spaceId = d.envService.get(p.id).spaceId;
    await d.envService.removeWorktree(p.id, p.acknowledge);
    rpc.broadcast("environments.changed", { spaceId });
    return { ok: true as const };
  });

  reg("checkpoints.list", (p) => d.checkpoints.list(p.environmentId, p.sessionId));
  reg("checkpoints.capture", async (p) => {
    const cp = await d.checkpoints.capture({ environmentId: p.environmentId, sessionId: p.sessionId, kind: "manual", label: p.label });
    if (!cp) throw new RpcError("NOT_A_REPOSITORY", "this checkout is not a git repository, so it cannot be checkpointed");
    rpc.broadcast("checkpoints.changed", { environmentId: p.environmentId });
    return cp;
  });
  reg("checkpoints.preview", (p) => d.checkpoints.preview(p.id));
  reg("checkpoints.restore", async (p) => {
    const result = await d.checkpoints.restore(p.id, p.acknowledge);
    // A restore rewrites the working tree, so every cached diff and git chip for that checkout is
    // stale — and it also produced a `pre-restore` checkpoint the list does not have yet.
    changed(result.path);
    rpc.broadcast("checkpoints.changed", { environmentId: result.environmentId });
    return result;
  });

  // Deep search (Plan 16 W1). Profile-scoped server-side — the service's joins are the enforcement,
  // and the service itself checks the profile exists (a typo'd id should say so, not answer empty).
  reg("search.query", (p) => d.search.query(p.profileId, p.query, p.limit));

  // Import from the agent CLIs' own stores. `scan` is a pure read — it opens ~/.claude, ~/.codex and
  // ~/.cursor read-only and answers; nothing is created by looking. `apply` is the only writer, and
  // broadcasts its own items/spaces/memory/skills changes once at the end rather than per row.
  reg("import.scan", () => d.imports.scan());
  reg("import.apply", (p) => d.imports.apply(p));

  reg("items.list", (p) => d.items.list(p.spaceId));
  reg("items.listAll", () => d.items.listAll());
  reg("items.create", (p) => { const r = d.items.create(p); rpc.broadcast("items.changed", { spaceId: r.spaceId }); return r; });
  reg("items.update", (p) => { const r = d.items.update(p); rpc.broadcast("items.changed", { spaceId: r.spaceId }); return r; });
  reg("items.delete", async (p) => {
    const it = d.items.get(p.id);
    if (it?.kind === "terminal") { d.terminals.close(it.refId); return { ok: true as const }; } // closes pty + row + item, broadcasts
    if (it?.kind === "browser") { d.browsers.close(it.refId); return { ok: true as const }; } // deletes row + item, broadcasts
    if (it?.kind === "session") { await d.sessions.delete(it.refId); return { ok: true as const }; } // disposes handle + row + item, broadcasts
    d.items.delete(p.id);
    if (it) rpc.broadcast("items.changed", { spaceId: it.spaceId });
    return { ok: true as const };
  });

  // The port block is claimed here, not in TerminalService: allocation probes the machine's ports
  // and so is async, while `open` must stay synchronous around its pty/row/item transaction. By the
  // time `open` reads the environment back, the block is on the row.
  reg("terminals.create", async (p) => {
    const env = p.cwd ? d.environments.findByPath(p.spaceId, p.cwd) : d.environments.ensurePrimary(p.spaceId);
    if (env) await d.ports.ensureBlock(env.id);
    return d.terminals.open(p);
  });
  reg("terminals.write", (p) => { d.terminals.write(p.terminalId, p.data); return { ok: true as const }; });
  reg("terminals.prefill", async (p) => { await d.terminals.prefill(p.terminalId, p.command); return { ok: true as const }; });
  reg("terminals.resize", (p) => { d.terminals.resize(p.terminalId, p.cols, p.rows); return { ok: true as const }; });
  reg("terminals.close", (p) => { d.terminals.close(p.terminalId); return { ok: true as const }; });

  reg("browsers.create", (p) => d.browsers.open(p));
  reg("browsers.get", (p) => d.browsers.get(p.browserId));
  reg("browsers.update", (p) => { d.browsers.update(p.browserId, p); return { ok: true as const }; });
  reg("browsers.close", (p) => { d.browsers.close(p.browserId); return { ok: true as const }; });

  // The browser agent host's bridge (Plan 11 W3). `register` is raw `rpc.register` rather than `reg`
  // because it is the one method that needs its caller's socket — the bridge sends that exact client
  // its `browserHost.op` events from then on.
  rpc.register("browserHost.register", Methods["browserHost.register"].params, async (_p, ctx) => {
    d.browserBridge.register(ctx.client);
    return { ok: true as const };
  });
  reg("browserHost.result", (p) => { d.browserBridge.handleResult(p); return { ok: true as const }; });

  // The feed (Plan 12 W5). Reads and read-marking only: rows are written by the producers' hooks
  // (sessions, hub, refusal sites), never over RPC. Both answers carry the server-computed unread
  // count, the sidebar pill's one source; the service broadcasts `notifications.changed` itself.
  reg("notifications.list", (p) => d.notifications.list(p));
  reg("notifications.markRead", (p) => d.notifications.markRead(p));

  // The reviewer recipe (Plan 13 W3). `request` returns the moment the reviewer session exists; the
  // verdict arrives later as `review.changed` + a `review_done` notification. Reads and dismissal go
  // through the service so the persisted KV blob has exactly one owner.
  reg("review.request", (p) => d.reviews.request(p.environmentId));
  reg("review.get", (p) => ({ review: d.reviews.get(p.environmentId) }));
  reg("review.dismiss", (p) => { d.reviews.dismiss(p.environmentId); return { ok: true as const }; });

  reg("agents.probe", (p) => d.sessions.probe({ force: p.force }));
  reg("sessions.list", (p) => d.sessions.list(p.spaceId));
  reg("sessions.listAll", () => d.sessions.listAll());
  reg("sessions.get", (p) => d.sessions.get(p.id));
  // `userDispatched` (W2's ⌘⇧↩) maps to the ONE origin a client may claim; the agent origins are
  // recorded by the server-side tools that create those children, never over RPC.
  reg("sessions.create", (p) => d.sessions.create({ ...p, dispatchedBy: p.userDispatched ? { kind: "user-dispatch", sessionId: null } : null }));
  reg("sessions.send", async (p) => { await d.sessions.send(p.id, { text: p.text, attachments: p.attachments, mentions: p.mentions }); return { ok: true as const }; });
  reg("sessions.interrupt", async (p) => { await d.sessions.interrupt(p.id); return { ok: true as const }; });
  reg("sessions.respondPermission", (p) => { d.sessions.respondPermission(p.id, p.requestId, p.decision, p.answers); return { ok: true as const }; });
  reg("sessions.setOptions", (p) => d.sessions.setOptions(p.id, { model: p.model, effort: p.effort, permissionMode: p.permissionMode }));
  reg("sessions.setAgent", (p) => d.sessions.setAgent(p.id, p.agentKind));
  reg("sessions.setEnvironment", (p) => d.sessions.setEnvironment(p.id, p.environmentId));
  reg("sessions.moveToSpace", (p) => d.sessions.moveToSpace(p.id, p.spaceId));
  reg("sessions.events", (p) => d.sessions.events(p.id, p.afterSeq, p.limit));
  reg("sessions.openTerminal", (p) => d.sessions.openTerminal(p.id));
  // "Fork from here" (Plan 16 W3): new worktree at the checkpoint's tree + new session carrying the
  // ancestor transcript as text. The service broadcasts environments.changed; sessions.create's own
  // items.changed already rode out of createSession.
  reg("sessions.fork", (p) => d.forks.fork(p.checkpointId));
  reg("sessions.delete", async (p) => { await d.sessions.delete(p.id); return { ok: true as const }; });
}
