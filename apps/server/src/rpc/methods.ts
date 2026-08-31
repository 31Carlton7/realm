import { Methods, type MethodName, type MethodResult } from "@realm/contracts";
import type { z } from "zod";
import type { RpcServer } from "./server";
import type { ProfilesStore } from "../store/profiles";
import type { SpacesStore } from "../store/spaces";
import type { ProjectsStore } from "../store/projects";
import type { EnvironmentsStore } from "../store/environments";
import type { EnvironmentService } from "../environments/service";
import type { CheckpointService } from "../checkpoints/service";
import type { ItemsStore } from "../store/items";
import type { SettingsStore } from "../store/settings";
import type { SkillsService } from "../skills/service";
import type { McpService } from "../mcp/service";
import type { MemoryService } from "../memory/service";
import type { TerminalService } from "../terminals/service";
import type { SessionService } from "../sessions/service";
import type { GitInfoService } from "../workspace/git-info";
import type { GitDiffService } from "../workspace/git-diff";
import type { GitWriteService } from "../workspace/git-write";
import type { PortAllocator } from "../workspace/ports";
import { NotFoundError, RpcError } from "../store/rows";

/** Parsed (post-default) params, i.e. what the handler actually receives. */
type Params<M extends MethodName> = z.infer<(typeof Methods)[M]["params"]>;
type Result<M extends MethodName> = MethodResult<M> | Promise<MethodResult<M>>;

export type Deps = {
  rpc: RpcServer; home: string; version: string;
  profiles: ProfilesStore; spaces: SpacesStore; projects: ProjectsStore; environments: EnvironmentsStore; envService: EnvironmentService; items: ItemsStore; settings: SettingsStore; skills: SkillsService; mcp: McpService; memory: MemoryService; terminals: TerminalService; sessions: SessionService; gitInfo: GitInfoService; gitDiff: GitDiffService; gitWrite: GitWriteService; ports: PortAllocator; checkpoints: CheckpointService;
};

export function registerMethods(d: Deps): void {
  const { rpc } = d;
  const reg = <M extends MethodName>(name: M, fn: (p: Params<M>) => Result<M>) =>
    rpc.register(name, Methods[name].params, async (p) => fn(p as Params<M>));

  reg("system.info", () => ({ realmHome: d.home, version: d.version }));

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
    const result = await d.gitWrite.ship(p);
    // Broadcast even when a step reported a problem: a commit that succeeded before a push that was
    // rejected still moved the tree, and the pane must show that.
    changed(p.cwd);
    return result;
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
  reg("spaces.delete", async (p) => {
    if (d.spaces.get(p.id)) { d.terminals.closeAllInSpace(p.id); await d.sessions.deleteAllInSpace(p.id); }
    d.spaces.delete(p.id);
    rpc.broadcast("spaces.changed", {});
    return { ok: true as const };
  });

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

  // Every one of these checks the space exists first, for the same reason the skills pair does: the
  // enable set is keyed by space id, so a typo would silently read and write preferences for a space
  // that is not there rather than saying so.
  reg("mcp.list", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    return d.mcp.list(p.spaceId);
  });
  reg("mcp.add", (p) => {
    if (p.spaceId !== null && !d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    const server = d.mcp.add(p, p.spaceId);
    rpc.broadcast("mcp.changed", {});
    return server;
  });
  reg("mcp.update", (p) => {
    if (p.spaceId !== null && !d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    const server = d.mcp.update(p.id, p, p.spaceId);
    rpc.broadcast("mcp.changed", {});
    return server;
  });
  reg("mcp.remove", (p) => {
    d.mcp.remove(p.id, d.spaces.listAll().map((s) => s.id));
    rpc.broadcast("mcp.changed", {});
    return { ok: true as const };
  });
  // No broadcast and no write: a probe, not a mutation.
  reg("mcp.test", (p) => d.mcp.test(p.id));
  reg("mcp.setEnabled", (p) => {
    if (!d.spaces.get(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    d.mcp.setEnabled(p.spaceId, p.id, p.enabled);
    rpc.broadcast("mcp.changed", {});
    return { ok: true as const };
  });

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

  reg("items.list", (p) => d.items.list(p.spaceId));
  reg("items.listAll", () => d.items.listAll());
  reg("items.create", (p) => { const r = d.items.create(p); rpc.broadcast("items.changed", { spaceId: r.spaceId }); return r; });
  reg("items.update", (p) => { const r = d.items.update(p); rpc.broadcast("items.changed", { spaceId: r.spaceId }); return r; });
  reg("items.delete", async (p) => {
    const it = d.items.get(p.id);
    if (it?.kind === "terminal") { d.terminals.close(it.refId); return { ok: true as const }; } // closes pty + row + item, broadcasts
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

  reg("agents.probe", (p) => d.sessions.probe({ force: p.force }));
  reg("sessions.list", (p) => d.sessions.list(p.spaceId));
  reg("sessions.listAll", () => d.sessions.listAll());
  reg("sessions.get", (p) => d.sessions.get(p.id));
  reg("sessions.create", (p) => d.sessions.create(p));
  reg("sessions.send", async (p) => { await d.sessions.send(p.id, { text: p.text, attachments: p.attachments, mentions: p.mentions }); return { ok: true as const }; });
  reg("sessions.interrupt", async (p) => { await d.sessions.interrupt(p.id); return { ok: true as const }; });
  reg("sessions.respondPermission", (p) => { d.sessions.respondPermission(p.id, p.requestId, p.decision); return { ok: true as const }; });
  reg("sessions.setOptions", (p) => d.sessions.setOptions(p.id, { model: p.model, effort: p.effort, permissionMode: p.permissionMode }));
  reg("sessions.setAgent", (p) => d.sessions.setAgent(p.id, p.agentKind));
  reg("sessions.events", (p) => d.sessions.events(p.id, p.afterSeq, p.limit));
  reg("sessions.openTerminal", (p) => d.sessions.openTerminal(p.id));
  reg("sessions.delete", async (p) => { await d.sessions.delete(p.id); return { ok: true as const }; });
}
