import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentKindSchema, type Item, type Session, type Space, type StoredSessionEvent } from "@realm/contracts";
import { MobileCalls, type MobileErrorCode, type MobileMethod, type Row, type SessionRow } from "@realm/remote";
import { SessionProjector } from "./rows";
import { RpcCallError, type RpcPort } from "./rpc-port";

/**
 * mobile.v1 on the Mac (PROTOCOL.md §8): each call validated against its schema, then answered by the
 * desktop's own RPC methods — the same handlers, validation and broadcasts as the desktop gets. The
 * phone never names an RPC method; it names a mobile.v1 call, and only these exist.
 */

export class MobileError extends Error {
  constructor(readonly code: MobileErrorCode, message: string) { super(message); }
}

/** A phone's channel: the port its calls go through, as that phone, and its open sessions — each with
 *  its own projector so rows are folded once per phone. */
export type ChannelContext = {
  phoneId: string;
  rpc: RpcPort;
  sessions: Map<string, { projector: SessionProjector; buffer: StoredSessionEvent[] | null }>;
};

const HISTORY_PAGE = 2_000;
/** A transcript longer than this is shown from its newest end; Phase 2 adds paging backwards. */
const HISTORY_LIMIT = 20_000;

const mobileStatus = (s: Session["status"]): SessionRow["status"] => (s === "waiting_permission" ? "waiting" : s);

const isUnread = (s: Session): boolean => s.seenSeq > 0 && s.lastEventSeq > s.seenSeq;

export class MobileApi {
  constructor(private readonly o: { macName: () => string; reportsDir: string; dev: boolean }) {}

  async handle(ctx: ChannelContext, method: string, params: unknown): Promise<unknown> {
    if (!Object.hasOwn(MobileCalls, method)) throw new MobileError("METHOD_NOT_FOUND", `no mobile.v1 call ${method}`);
    const m = method as MobileMethod;
    const parsed = MobileCalls[m].params.safeParse(params ?? {});
    if (!parsed.success) throw new MobileError("INVALID_PARAMS", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const p = parsed.data as Record<string, unknown>;
    const rpc = ctx.rpc;
    try {
      switch (m) {
        case "ping": return { at: Date.now() };
        case "home.get": return await this.home(rpc);
        case "session.open": return await this.open(ctx, p.id as string, p.limit as number);
        case "session.close": ctx.sessions.delete(p.id as string); return { ok: true };
        case "session.send":
          await rpc.call("sessions.send", { id: p.id as string, text: p.text as string, delivery: p.delivery as "auto" | "queue" | "steer" });
          return { ok: true };
        case "session.answer":
          await rpc.call("sessions.respondPermission", {
            id: p.id as string, requestId: p.requestId as string, decision: p.decision as "allow" | "allow_always" | "deny",
            ...(p.answers ? { answers: p.answers as Record<string, string> } : {}),
          });
          return { ok: true };
        case "session.stop": await rpc.call("sessions.interrupt", { id: p.id as string }); return { ok: true };
        case "session.seen": await rpc.call("sessions.markSeen", { id: p.id as string, seq: p.seq as number }); return { ok: true };
        case "session.create": {
          const agent = AgentKindSchema.safeParse(p.agent);
          if (!agent.success) throw new MobileError("INVALID_PARAMS", `unknown agent ${String(p.agent)}`);
          const { session } = await rpc.call("sessions.create", { spaceId: p.spaceId as string, agentKind: agent.data });
          await rpc.call("sessions.send", { id: session.id, text: p.text as string });
          return { id: session.id };
        }
        case "debug.report": {
          if (!this.o.dev) throw new MobileError("FORBIDDEN", "debug.report is for development builds");
          mkdirSync(this.o.reportsDir, { recursive: true });
          writeFileSync(join(this.o.reportsDir, `${p.name as string}-${ctx.phoneId}-${Date.now()}.json`), JSON.stringify(p.data, null, 1));
          return { ok: true };
        }
      }
    } catch (e) {
      if (e instanceof MobileError) throw e;
      if (e instanceof RpcCallError) {
        const code: MobileErrorCode = e.code === "NOT_FOUND" || e.code === "SESSION_NOT_LIVE" || e.code === "INVALID_PARAMS" ? e.code : "INTERNAL";
        throw new MobileError(code, e.message);
      }
      throw new MobileError("INTERNAL", (e as Error).message);
    }
  }

  private async lists(rpc: RpcPort): Promise<{ spaces: Space[]; sessions: Session[]; items: Item[] }> {
    const [spaces, sessions, items] = await Promise.all([
      rpc.call("spaces.list", {}),
      rpc.call("sessions.listAll", { profileId: null }),
      rpc.call("items.listAll", {}),
    ]);
    return { spaces, sessions, items };
  }

  private row(s: Session, title: string, space: Space | undefined): SessionRow {
    const needsYou = s.status === "waiting_permission" || (s.status === "error" && isUnread(s));
    return {
      id: s.id, title: title || s.title, spaceId: s.spaceId, spaceName: space?.name ?? "", agent: s.agentKind, model: s.model,
      status: mobileStatus(s.status), needsYou, unread: isUnread(s), updatedAt: s.updatedAt,
    };
  }

  /** Needs you is the sidebar's rule (Plan 27): everything waiting on a permission or a question, then
   *  failures not yet read that the person owns. Phase 2 imports the sidebar's own `needsYou()`. */
  async home(rpc: RpcPort): Promise<unknown> {
    const { spaces, sessions, items } = await this.lists(rpc);
    const spaceById = new Map(spaces.map((s) => [s.id, s]));
    const titles = new Map<string, string>();
    for (const it of items) if (it.kind === "session") titles.set(it.refId, it.title);
    const rows = sessions.map((s) => ({ s, row: this.row(s, titles.get(s.id) ?? "", spaceById.get(s.spaceId)) }));
    const needsYou = rows
      .filter(({ s }) => s.status === "waiting_permission" || (s.status === "error" && isUnread(s) && !s.dispatchedBy?.sessionId && titles.has(s.id)))
      .sort((a, b) => (a.s.status === b.s.status ? a.s.updatedAt - b.s.updatedAt : a.s.status === "waiting_permission" ? -1 : 1))
      .map(({ row }) => row);
    const listed = rows.filter(({ s }) => titles.has(s.id));
    return {
      mac: { name: this.o.macName() },
      needsYou,
      spaces: spaces.map((sp) => {
        const mine = listed.filter(({ s }) => s.spaceId === sp.id).sort((a, b) => b.s.updatedAt - a.s.updatedAt);
        return { id: sp.id, name: sp.name, icon: sp.icon, color: sp.color, sessions: mine.slice(0, 5).map(({ row }) => row), more: Math.max(0, mine.length - 5) };
      }),
    };
  }

  /** Subscribes first and buffers, then reads history, then replays what arrived meanwhile — so no event
   *  can fall between the history read and the live stream. */
  private async open(ctx: ChannelContext, id: string, limit: number): Promise<{ session: SessionRow; rows: Row[]; hasMore: boolean }> {
    const entry = { projector: new SessionProjector(), buffer: [] as StoredSessionEvent[] | null };
    ctx.sessions.set(id, entry);
    const rpc = ctx.rpc;
    try {
      const session = await rpc.call("sessions.get", { id });
      let after = 0;
      let total = 0;
      for (;;) {
        const page = await rpc.call("sessions.events", { id, afterSeq: after, limit: HISTORY_PAGE });
        for (const ev of page) entry.projector.apply(ev);
        total += page.length;
        if (page.length < HISTORY_PAGE || total >= HISTORY_LIMIT) break;
        after = page.at(-1)!.seq;
      }
      for (const ev of entry.buffer ?? []) entry.projector.apply(ev);
      entry.buffer = null;
      const [items, spaces] = await Promise.all([rpc.call("items.listAll", {}), rpc.call("spaces.list", {})]);
      const title = items.find((it) => it.kind === "session" && it.refId === id)?.title ?? "";
      const all = entry.projector.all();
      return { session: this.row(session, title, spaces.find((s) => s.id === session.spaceId)), rows: all.slice(-limit), hasMore: all.length > limit };
    } catch (e) {
      ctx.sessions.delete(id);
      throw e;
    }
  }
}
