import { DEFAULT_PERMISSION_MODE_KEY, MODEL_EFFORTS_KEY, readEffortSupport, type AgentKind, type Session } from "@realm/contracts";
import { QUICK_CHAT_MODEL_SETTING, effortOptions, quickChatModelOf, type QuickChatModel } from "@realm/view";
import { NotFoundError } from "../store/rows";
import type { SettingsStore } from "../store/settings";
import { resolveDefaultPermissionMode, type SessionService } from "./service";

/**
 * How long a started engine waits for the next quick chat before it is stopped. Five minutes covers
 * the run of questions a person asks one after another, and stops a Claude CLI (a few hundred MB)
 * well before the 30 minutes the general engine reaper would hold it for.
 */
export const QUICK_CHAT_WARM_MS = 5 * 60_000;

/** Where the spare's session id is kept, so a server that stopped while one was waiting deletes it on
 *  its next start: the spare's row belongs to no list, and nothing else would ever remove it. */
export const QUICK_CHAT_SPARE_SETTING = "quickChat.spare";

type Wanted = QuickChatModel & { effort: string | null; permissionMode: string };
type Spare = Wanted & { id: string; spaceId: string; timer: NodeJS.Timeout };

/**
 * The quick chat's sessions, and the one engine kept started for the next of them.
 *
 * Each quick chat is a NEW session on the engine and model `QUICK_CHAT_MODEL_SETTING` names. When one
 * is deleted, a spare session is created and its engine started at once, with nothing sent to it. The
 * next quick chat takes that spare if it matches what the setting says now and the space it opens in,
 * so the first message goes to an engine that is already up. A spare that matches nothing is deleted
 * and a cold one made, so a changed model is never answered by the old one.
 *
 * A quick chat starts on the lowest reasoning level its model takes. It is for a quick question, and
 * the default level is the one a coding session wants; the chat's own picker raises it. Every other
 * session keeps the default.
 *
 * Fresh by construction: the spare is a session that has never had a message, so it holds no provider
 * session id, no transcript and no context from the chat before it. Reusing the closed chat's own
 * process would carry its conversation into the next, which is why it is a new one.
 */
export class QuickChatEngines {
  private spare: Spare | null = null;
  /** The quick chats this server opened, by space, so their deletion is what starts a spare. */
  private open = new Map<string, string>();

  constructor(private d: {
    sessions: Pick<SessionService, "create" | "get" | "delete" | "warm" | "probeCached">;
    settings: Pick<SettingsStore, "get" | "set">;
    registered: readonly AgentKind[];
    warmMs?: number;
  }) {}

  /** What a quick chat starts on now. Read by the meeting assistant's live answers too. */
  model(): QuickChatModel {
    return quickChatModelOf(this.d.settings.get(QUICK_CHAT_MODEL_SETTING), this.d.sessions.probeCached()?.rows ?? [], this.d.registered);
  }

  /** A session for a new quick chat in `spaceId`: the spare when it matches, else a new one. */
  async start(spaceId: string): Promise<Session> {
    const want = this.wanted();
    const spare = this.take();
    const fits = spare !== null && spare.spaceId === spaceId && spare.agentKind === want.agentKind && spare.model === want.model
      && spare.effort === want.effort && spare.permissionMode === want.permissionMode;
    if (spare && !fits) await this.d.sessions.delete(spare.id).catch(() => {});
    // A spare whose space was deleted went with it.
    const kept = fits ? this.rowOf(spare.id) : null;
    const session = kept ?? this.create(spaceId, want).session;
    this.open.set(session.id, spaceId);
    return session;
  }

  /** A session was deleted. One of this server's quick chats starts the spare for the next. */
  async deleted(id: string): Promise<void> {
    const spaceId = this.open.get(id);
    if (spaceId === undefined) return;
    this.open.delete(id);
    try {
      await this.warm(spaceId);
    } catch (e) {
      console.error(`[quick-chat] could not make a spare session: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** A quick chat was saved to a space: it is that space's session now, and deleting it starts no spare. */
  kept(id: string): void {
    this.open.delete(id);
  }

  /** Delete a spare left by a server that stopped while it waited. */
  async dropLeftover(): Promise<void> {
    const id = this.d.settings.get(QUICK_CHAT_SPARE_SETTING);
    if (typeof id !== "string") return;
    this.d.settings.set(QUICK_CHAT_SPARE_SETTING, null);
    await this.d.sessions.delete(id).catch(() => {});
  }

  /** Stop and delete the spare, if one is waiting. */
  async stop(): Promise<void> {
    const spare = this.take();
    if (spare) await this.d.sessions.delete(spare.id).catch(() => {});
  }

  private async warm(spaceId: string): Promise<void> {
    await this.stop();
    const want = this.wanted();
    const { session } = this.create(spaceId, want);
    const timer = setTimeout(() => { void this.stop(); }, this.d.warmMs ?? QUICK_CHAT_WARM_MS);
    timer.unref?.();
    this.spare = { id: session.id, spaceId, ...want, timer };
    this.d.settings.set(QUICK_CHAT_SPARE_SETTING, session.id);
    try {
      await this.d.sessions.warm(session.id);
    } catch (e) {
      console.error(`[quick-chat] could not start the spare engine: ${e instanceof Error ? e.message : String(e)}`);
      if (this.spare?.id === session.id) await this.stop();
    }
  }

  private rowOf(id: string): Session | null {
    try { return this.d.sessions.get(id); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
  }

  private take(): Spare | null {
    const spare = this.spare;
    if (!spare) return null;
    clearTimeout(spare.timer);
    this.spare = null;
    this.d.settings.set(QUICK_CHAT_SPARE_SETTING, null);
    return spare;
  }

  private wanted(): Wanted {
    const m = this.model();
    const levels = effortOptions({ kind: m.agentKind, model: m.model, agentProbe: this.d.sessions.probeCached()?.rows ?? [],
      remembered: readEffortSupport(this.d.settings.get(MODEL_EFFORTS_KEY)) }).levels;
    return { ...m, effort: levels[0]?.id ?? null, permissionMode: resolveDefaultPermissionMode(m.agentKind, this.d.settings.get(DEFAULT_PERMISSION_MODE_KEY)) };
  }

  private create(spaceId: string, want: Wanted) {
    return this.d.sessions.create({ spaceId, agentKind: want.agentKind, model: want.model, effort: want.effort, permissionMode: want.permissionMode, projectId: null, unlisted: true });
  }
}
