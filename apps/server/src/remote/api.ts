import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_META, AgentKindSchema, parseSpaceIcon, type AgentKind, type IconAsset, type Item, type MethodResult, type Session, type Space,
  type StoredSessionEvent, type TurnChanges,
} from "@realm/contracts";
import { MobileCalls, type Home, type MobileErrorCode, type MobileMethod, type MobileResult, type Row, type SessionRow } from "@realm/remote";
import { modelLabel, needsYou, QUICK_CHAT_SETTING, quickChatIdOf, type NeedsYouState } from "@realm/view";
import { diffPage } from "./changes";
import { filePreview, PreviewRefused, type Downscale } from "./preview";
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
/** How long Home waits on the agents' probe for the names of their models. A probe already made
 *  answers at once; one never made takes as long as the slowest agent, and Home does not wait on it. */
const PROBE_WAIT_MS = 50;
/** The most a space's picture may weigh to be sent (`space.icon`). */
export const ICON_MAX_BYTES = 256 * 1024;

const mobileStatus = (s: Session["status"]): SessionRow["status"] => (s === "waiting_permission" ? "waiting" : s);

const isUnread = (s: Session): boolean => s.seenSeq > 0 && s.lastEventSeq > s.seenSeq;

/** What realm-server knows, as one listing: every space, session and item, and the quick chat's
 *  session, which its window keeps in a setting. */
type Lists = { spaces: Space[]; sessions: Session[]; items: Item[]; quickChatId: string | null };

type Probe = MethodResult<"agents.probe">;

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

/** A space's icon, read the way the desktop's `SpaceIcon` reads it. */
function iconOf(icon: string): Pick<Home["spaces"][number], "iconKind" | "glyph" | "emoji"> {
  const ref = parseSpaceIcon(icon);
  if (ref.kind === "emoji") return { iconKind: "emoji", emoji: ref.char };
  if (ref.kind === "asset") return { iconKind: "picture" };
  return { iconKind: "glyph", glyph: ref.name };
}

/** An icon asset's picture: an SVG's own text, or a data URL's bytes. */
function pictureOf(asset: IconAsset): { mime: string; data: Buffer } | null {
  if (!asset.dataText.startsWith("data:")) return asset.mime === "image/svg+xml" ? { mime: asset.mime, data: Buffer.from(asset.dataText, "utf8") } : null;
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(asset.dataText);
  if (!m) return null;
  try {
    return { mime: m[1]!, data: m[2] ? Buffer.from(m[3]!, "base64") : Buffer.from(decodeURIComponent(m[3]!), "utf8") };
  } catch {
    return null;
  }
}

export class MobileApi {
  constructor(private readonly o: { macName: () => string; reportsDir: string; dev: boolean; downscale?: Downscale }) {}

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
        case "session.answer": {
          // The desktop's own answer shape — question id → an option's value or words of the person's
          // own, several as a list — handed on as it came: the server holds it to the request's card.
          const answers = p.answers as Record<string, string | string[]> | undefined;
          await rpc.call("sessions.respondPermission", {
            id: p.id as string, requestId: p.requestId as string, decision: p.decision as "allow" | "allow_always" | "deny",
            ...(answers ? { answers } : {}),
          });
          return { ok: true };
        }
        case "session.stop": await rpc.call("sessions.interrupt", { id: p.id as string }); return { ok: true };
        case "session.seen": await rpc.call("sessions.markSeen", { id: p.id as string, seq: p.seq as number }); return { ok: true };
        case "session.create": {
          const agent = AgentKindSchema.safeParse(p.agent);
          if (!agent.success) throw new MobileError("INVALID_PARAMS", `unknown agent ${String(p.agent)}`);
          const { session } = await rpc.call("sessions.create", { spaceId: p.spaceId as string, agentKind: agent.data });
          await rpc.call("sessions.send", { id: session.id, text: p.text as string });
          return { id: session.id };
        }
        case "session.changes": {
          const { checkpointId, files, totalFiles } = await this.turnChanges(rpc, p.id as string, p.checkpointId as string);
          return { checkpointId, files: files.map(({ path, oldPath, status, additions, deletions }) => ({ path, oldPath, status, additions, deletions })), totalFiles };
        }
        case "session.diff": return await this.diff(rpc, p.id as string, p.checkpointId as string, p.path as string, p.from as number);
        case "session.file": return await this.file(rpc, p.id as string, p.path as string);
        case "space.icon": return await this.spaceIcon(rpc, p.id as string);
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
        // A turn's trees gone from the repository, or a checkout that is no longer one, are things that
        // are not there any more, as far as a phone can do anything about them.
        const code: MobileErrorCode = e.code === "NOT_FOUND" || e.code === "SESSION_NOT_LIVE" || e.code === "INVALID_PARAMS" ? e.code
          : e.code === "TREE_GONE" || e.code === "NOT_A_REPOSITORY" ? "NOT_FOUND" : "INTERNAL";
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

  /** What the agents' probes last said, for the names of their models — when it answers at once. */
  private async probes(rpc: RpcPort): Promise<Probe> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PROBE_WAIT_MS); });
    const rows = await Promise.race([rpc.call("agents.probe", { force: false }).catch(() => null), late]);
    clearTimeout(timer);
    return rows ?? [];
  }

  /** `need` is the ids Needs you lists, so a row says it is in that list exactly when it is. */
  private row(s: Session, title: string, space: Space | undefined, need: ReadonlySet<string>, probe: Probe): SessionRow {
    const meta = AGENT_META[s.agentKind as AgentKind] as { label: string; icon: string } | undefined;
    return {
      id: s.id, title: title || s.title, spaceId: s.spaceId, spaceName: space?.name ?? "", agent: s.agentKind, model: s.model,
      status: mobileStatus(s.status), needsYou: need.has(s.id), unread: isUnread(s), updatedAt: s.updatedAt,
      agentName: meta?.label ?? s.agentKind, agentMark: meta?.icon ?? "bot",
      modelLabel: meta ? modelLabel(s.agentKind, s.model, probe) : s.model ?? "",
    };
  }

  /** Needs you is the sidebar's own rule (`@realm/view`), run on the lists the sidebar is seeded
   *  from; then each space's sessions, newest first. */
  async home(rpc: RpcPort): Promise<unknown> {
    const [lists, probe] = await Promise.all([this.lists(rpc), this.probes(rpc)]);
    const { spaces, sessions, items } = lists;
    const spaceById = new Map(spaces.map((s) => [s.id, s]));
    const titles = new Map<string, string>();
    for (const it of items) if (it.kind === "session") titles.set(it.refId, it.title);
    const waiting = needsYou(needsYouInput(lists));
    const need = new Set(waiting.map((r) => r.session.id));
    const listed = sessions.filter((s) => titles.has(s.id));
    return {
      mac: { name: this.o.macName() },
      needsYou: waiting.map((r) => this.row(r.session, r.title, spaceById.get(r.spaceId), need, probe)),
      spaces: spaces.map((sp) => {
        const mine = listed.filter((s) => s.spaceId === sp.id).sort((a, b) => b.updatedAt - a.updatedAt);
        return {
          id: sp.id, name: sp.name, icon: sp.icon, color: sp.color, ...iconOf(sp.icon),
          sessions: mine.slice(0, 5).map((s) => this.row(s, titles.get(s.id) ?? "", sp, need, probe)), more: Math.max(0, mine.length - 5),
        };
      }),
    };
  }

  /** Subscribes first and buffers, then reads history, then replays what arrived meanwhile — so no event
   *  can fall between the history read and the live stream. */
  private async open(ctx: ChannelContext, id: string, limit: number): Promise<{ session: SessionRow; rows: Row[]; hasMore: boolean; hint: string | null }> {
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
      const [lists, probe] = await Promise.all([this.lists(rpc), this.probes(rpc)]);
      const title = lists.items.find((it) => it.kind === "session" && it.refId === id)?.title ?? "";
      const need = new Set(needsYou(needsYouInput(lists)).map((r) => r.session.id));
      const all = entry.projector.all();
      return {
        session: this.row(session, title, lists.spaces.find((s) => s.id === session.spaceId), need, probe),
        rows: all.slice(-limit), hasMore: all.length > limit, hint: entry.projector.hint,
      };
    } catch (e) {
      ctx.sessions.delete(id);
      throw e;
    }
  }

  /** Every event of one kind the session has, oldest first. */
  private async eventsOf(rpc: RpcPort, id: string, type: "turn_changes" | "files_made"): Promise<StoredSessionEvent[]> {
    const out: StoredSessionEvent[] = [];
    for (let after = 0; ;) {
      const page = await rpc.call("sessions.events", { id, afterSeq: after, limit: HISTORY_PAGE, types: [type] });
      out.push(...page);
      if (page.length < HISTORY_PAGE) return out;
      after = page.at(-1)!.seq;
    }
  }

  /** The turn of this session that `checkpointId` fronted, as its `turn_changes` recorded it. Another
   *  session's checkpoint is no turn of this one. */
  private async turnChanges(rpc: RpcPort, id: string, checkpointId: string): Promise<TurnChanges> {
    for (const ev of await this.eventsOf(rpc, id, "turn_changes")) {
      if (ev.event.type === "turn_changes" && ev.event.payload.checkpointId === checkpointId) return ev.event.payload;
    }
    throw new MobileError("NOT_FOUND", "No turn of this session changed files from that checkpoint.");
  }

  /** One page of a file's diff across a turn: only a file that turn's changes list, between the two
   *  trees the turn recorded — the phone names neither a tree nor any other path. */
  private async diff(rpc: RpcPort, id: string, checkpointId: string, path: string, from: number): Promise<MobileResult<"session.diff">> {
    const changes = await this.turnChanges(rpc, id, checkpointId);
    const file = changes.files.find((f) => f.path === path);
    if (!file) throw new MobileError("FORBIDDEN", "That file is not one this turn changed.");
    const patch = await rpc.call("checkpoints.turnDiff", { id: checkpointId, afterTree: changes.afterTree, path: file.path, oldPath: file.oldPath });
    return diffPage(file, patch, from);
  }

  /** A preview of a file the session's turns made — and of nothing else: the path must be one a
   *  `files_made` of this session listed, exactly as it was listed. */
  private async file(rpc: RpcPort, id: string, path: string): Promise<MobileResult<"session.file">> {
    const made = new Set<string>();
    for (const ev of await this.eventsOf(rpc, id, "files_made")) if (ev.event.type === "files_made") for (const f of ev.event.payload.files) made.add(f.path);
    if (!made.has(path)) throw new MobileError("FORBIDDEN", "That file is not one this session made.");
    try {
      return await filePreview(path, { downscale: this.o.downscale });
    } catch (e) {
      if (e instanceof PreviewRefused) throw new MobileError("FORBIDDEN", e.message);
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new MobileError("NOT_FOUND", "That file is no longer on this Mac.");
      throw e;
    }
  }

  /** A space's own picture: the icon the person uploaded or had made for it, and only that. */
  private async spaceIcon(rpc: RpcPort, id: string): Promise<MobileResult<"space.icon">> {
    const space = (await rpc.call("spaces.list", {})).find((s) => s.id === id);
    if (!space) throw new MobileError("NOT_FOUND", "No such space.");
    const ref = parseSpaceIcon(space.icon);
    if (ref.kind !== "asset") throw new MobileError("NOT_FOUND", "This space's icon is not a picture.");
    const asset = (await rpc.call("iconAssets.list", { profileId: space.profileId })).find((a) => a.id === ref.id);
    const picture = asset ? pictureOf(asset) : null;
    if (!picture) throw new MobileError("NOT_FOUND", "This space's picture is gone.");
    if (picture.data.length > ICON_MAX_BYTES) throw new MobileError("NOT_FOUND", "This space's picture is too large to send to a phone.");
    return { mime: picture.mime, data: picture.data.toString("base64") };
  }
}
