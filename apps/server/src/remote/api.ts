import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentKindSchema, type Item, type Session, type Space, type StoredSessionEvent } from "@realm/contracts";
import { MobileCalls, type MobileErrorCode, type MobileMethod, type Row, type SessionRow } from "@realm/remote";
import { needsYou, QUICK_CHAT_SETTING, quickChatIdOf, type NeedsYouState } from "@realm/view";
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

/** What realm-server knows, as one listing: every space, session and item, and the quick chat's
 *  session, which its window keeps in a setting. */
type Lists = { spaces: Space[]; sessions: Session[]; items: Item[]; quickChatId: string | null };

/**
 * Needs you's input (`@realm/view`), built from the lists the desktop's own store is seeded from:
 * `sessions.listAll` for every session's row, status, space and the time its status last moved;
 * `items.listAll` for titles and what is listed (archived rows already left out); `spaces.list`; and
 * the quick chat's setting. A server holds no window, so no profile is the window's own: every item
 * comes in through `allItems`, as another profile's would in the sidebar.
 */
export function needsYouInput(l: Lists): NeedsYouState {
  const by = <T>(f: (s: Session) => T): Record<string, T> => Object.fromEntries(l.sessions.map((s) => [s.id, f(s)]));
  return {
    spaces: l.spaces, activeProfileId: null, items: [], allItems: l.items,
    sessions: {}, allSessions: by((s) => s),
    sessionStatus: by((s) => s.status), sessionSpace: by((s) => s.spaceId), sessionUpdatedAt: by((s) => s.updatedAt),
    quickChatId: l.quickChatId,
  };
}

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

  private async lists(rpc: RpcPort): Promise<Lists> {
    const [spaces, sessions, items, quickChat] = await Promise.all([
      rpc.call("spaces.list", {}),
      rpc.call("sessions.listAll", { profileId: null }),
      rpc.call("items.listAll", {}),
      rpc.call("settings.get", { key: QUICK_CHAT_SETTING }),
    ]);
    return { spaces, sessions, items, quickChatId: quickChatIdOf(quickChat.value) };
  }

  /** `need` is the ids Needs you lists, so a row says it is in that list exactly when it is. */
  private row(s: Session, title: string, space: Space | undefined, need: ReadonlySet<string>): SessionRow {
    return {
      id: s.id, title: title || s.title, spaceId: s.spaceId, spaceName: space?.name ?? "", agent: s.agentKind, model: s.model,
      status: mobileStatus(s.status), needsYou: need.has(s.id), unread: isUnread(s), updatedAt: s.updatedAt,
    };
  }

  /** Needs you is the sidebar's own rule (`@realm/view`), run on the lists the sidebar is seeded
   *  from; then each space's sessions, newest first. */
  async home(rpc: RpcPort): Promise<unknown> {
    const lists = await this.lists(rpc);
    const { spaces, sessions, items } = lists;
    const spaceById = new Map(spaces.map((s) => [s.id, s]));
    const titles = new Map<string, string>();
    for (const it of items) if (it.kind === "session") titles.set(it.refId, it.title);
    const waiting = needsYou(needsYouInput(lists));
    const need = new Set(waiting.map((r) => r.session.id));
    const listed = sessions.filter((s) => titles.has(s.id));
    return {
      mac: { name: this.o.macName() },
      needsYou: waiting.map((r) => this.row(r.session, r.title, spaceById.get(r.spaceId), need)),
      spaces: spaces.map((sp) => {
        const mine = listed.filter((s) => s.spaceId === sp.id).sort((a, b) => b.updatedAt - a.updatedAt);
        return { id: sp.id, name: sp.name, icon: sp.icon, color: sp.color, sessions: mine.slice(0, 5).map((s) => this.row(s, titles.get(s.id) ?? "", sp, need)), more: Math.max(0, mine.length - 5) };
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
      const lists = await this.lists(rpc);
      const title = lists.items.find((it) => it.kind === "session" && it.refId === id)?.title ?? "";
      const need = new Set(needsYou(needsYouInput(lists)).map((r) => r.session.id));
      const all = entry.projector.all();
      return { session: this.row(session, title, lists.spaces.find((s) => s.id === session.spaceId), need), rows: all.slice(-limit), hasMore: all.length > limit };
    } catch (e) {
      ctx.sessions.delete(id);
      throw e;
    }
  }
}
