import { PERSISTED_EVENT_TYPES, sessionEvent, type AgentKind, type Session, type SessionEvent, type StoredSessionEvent } from "@realm/contracts";
import type { AdapterRegistry, AgentHandle, PermissionDecision, ProbeResult, UserMessage } from "@realm/adapters";
import type { RpcServer } from "../rpc/server";
import type { ItemsStore } from "../store/items";
import type { ProjectsStore } from "../store/projects";
import type { SessionsStore, SessionEventsStore, SessionUpdate } from "../store/sessions";
import type { SpacesStore } from "../store/spaces";
import { NotFoundError, RpcError } from "../store/rows";

const AGENT_LABELS: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", "acp:gemini": "Gemini", "acp:cursor": "Cursor", fake: "Fake agent" };

export type CreateSessionInput = { spaceId: string; agentKind: AgentKind; projectId: string | null; model: string | null; effort: string | null; permissionMode: string; title?: string };
type Live = { handle: AgentHandle; pump: Promise<void> };

/**
 * Owns the session trio: DB row + sidebar item + live adapter handle. Adapter handles are started lazily on the
 * first `send` (and restarted with `resume` after they end), so a persisted session survives server restarts.
 * Every adapter event is persisted (except deltas) with a per-session seq and broadcast as `session.event`.
 */
export class SessionService {
  private live = new Map<string, Live>();
  private closing = false;
  constructor(private d: { rpc: RpcServer; sessions: SessionsStore; events: SessionEventsStore; items: ItemsStore; spaces: SpacesStore; projects: ProjectsStore; adapters: AdapterRegistry }) {}

  probeAll(): Promise<ProbeResult[]> {
    return Promise.all(Object.values(this.d.adapters).map((a) => a.probe()));
  }

  isLive(id: string): boolean { return this.live.has(id); }
  list(spaceId: string): Session[] { return this.d.sessions.list(spaceId); }
  get(id: string): Session { const s = this.d.sessions.get(id); if (!s) throw new NotFoundError("session", id); return s; }
  events(id: string, afterSeq: number, limit: number): StoredSessionEvent[] { this.get(id); return this.d.events.listAfter(id, afterSeq, limit); }

  create(input: CreateSessionInput): { session: Session; itemId: string } {
    const space = this.d.spaces.get(input.spaceId); if (!space) throw new NotFoundError("space", input.spaceId);
    if (!this.d.adapters[input.agentKind]) throw new RpcError("AGENT_UNAVAILABLE", `${input.agentKind} is not registered`);
    const project = input.projectId ? this.d.projects.get(input.projectId) : null;
    if (input.projectId && !project) throw new NotFoundError("project", input.projectId);
    const cwd = project?.rootPath ?? space.folderPath;
    const title = input.title?.trim() || `${AGENT_LABELS[input.agentKind]} session`;
    const session = this.d.sessions.create({ spaceId: input.spaceId, projectId: project?.id ?? null, agentKind: input.agentKind, model: input.model, effort: input.effort, permissionMode: input.permissionMode, cwd, title });
    const item = this.d.items.create({ spaceId: input.spaceId, kind: "session", title, refId: session.id });
    this.d.rpc.broadcast("items.changed", { spaceId: input.spaceId });
    return { session, itemId: item.id };
  }

  /** Emits `user_message` (persisted + broadcast) and hands the message to the adapter, starting it if needed. */
  async send(id: string, msg: UserMessage): Promise<void> {
    const handle = this.ensureLive(id);
    this.onEvent(id, sessionEvent("user_message", msg));
    await handle.send(msg);
  }
  async interrupt(id: string): Promise<void> { this.get(id); await this.live.get(id)?.handle.interrupt(); }
  respondPermission(id: string, requestId: string, decision: PermissionDecision): void { this.get(id); this.live.get(id)?.handle.respondPermission(requestId, decision); }
  async setOptions(id: string, o: { model?: string; effort?: string; permissionMode?: string }): Promise<Session> {
    const s = this.d.sessions.update({ id, ...o });
    await this.live.get(id)?.handle.setOptions({ model: o.model, permissionMode: o.permissionMode });
    return s;
  }

  /** Dispose the live handle (if any), then remove the item and the row (events cascade). */
  async delete(id: string): Promise<void> {
    const s = this.get(id);
    await this.stop(id);
    const item = this.d.items.findByRefId(id);
    if (item) this.d.items.delete(item.id);
    this.d.sessions.delete(id);
    this.d.rpc.broadcast("items.changed", { spaceId: s.spaceId });
  }
  /** Delete every session in the space (used before space deletion). */
  async deleteAllInSpace(spaceId: string): Promise<void> {
    for (const s of this.d.sessions.list(spaceId)) await this.delete(s.id);
  }
  /** Shutdown: dispose live handles; rows/items stay so sessions resume next boot. */
  async closeAll(): Promise<void> {
    this.closing = true;
    for (const id of [...this.live.keys()]) await this.stop(id);
  }
  /** Boot: a session can't still be running after a restart; only `error` is worth keeping. */
  markStaleOnBoot(): void {
    for (const s of this.d.sessions.listAll()) if (s.status === "running" || s.status === "waiting_permission" || s.status === "ended") this.d.sessions.update({ id: s.id, status: "idle" });
  }

  private async stop(id: string): Promise<void> {
    const l = this.live.get(id); if (!l) return;
    await l.handle.dispose();
    await l.pump; // pump ends when the adapter closes its event stream (right after `ended`)
    this.live.delete(id);
  }

  private ensureLive(id: string): AgentHandle {
    const existing = this.live.get(id); if (existing) return existing.handle;
    const s = this.get(id);
    const adapter = this.d.adapters[s.agentKind];
    if (!adapter) throw new RpcError("AGENT_UNAVAILABLE", `${s.agentKind} is not registered`);
    const handle = adapter.start({ cwd: s.cwd, model: s.model, effort: s.effort, permissionMode: s.permissionMode, mcpServers: [], resume: s.providerSessionId,
      onLog: (line) => console.error(`[session ${id.slice(-6)}] ${line}`) });
    const pump = (async () => {
      try { for await (const ev of handle.events) this.onEvent(id, ev); }
      catch (e) { console.error(`[sessions] pump failed for ${id}: ${e instanceof Error ? e.message : String(e)}`); }
      finally { if (this.live.get(id)?.handle === handle) this.live.delete(id); }
    })();
    this.live.set(id, { handle, pump });
    return handle;
  }

  private onEvent(id: string, ev: SessionEvent): void {
    if (this.closing) return; // shutdown: the row keeps its last real status; markStaleOnBoot resets it
    if (!this.d.sessions.get(id)) return; // deleted underneath a still-draining pump
    if (ev.type === "init") this.d.sessions.update({ id, providerSessionId: ev.payload.providerSessionId });
    if (ev.type === "status") {
      this.d.sessions.update({ id, status: ev.payload.status });
      this.d.rpc.broadcast("session.status", { sessionId: id, status: ev.payload.status });
    }
    if (PERSISTED_EVENT_TYPES.includes(ev.type)) {
      const stored = this.d.events.append(id, ev);
      this.d.sessions.update({ id, lastEventSeq: stored.seq });
      this.d.rpc.broadcast("session.event", { ...stored, ephemeral: false });
    } else {
      this.d.rpc.broadcast("session.event", { seq: -1, sessionId: id, event: ev, ephemeral: true });
    }
  }
}
