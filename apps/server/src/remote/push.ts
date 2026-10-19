import { createHash } from "node:crypto";
import { NOTIFICATIONS_IPHONE_KEY, type Notification, type NotificationCategory } from "@realm/contracts";
import type { PhoneTransport, RelayedNotification } from "../notifications/relay";
import type { SettingsStore } from "../store/settings";
import type { PushPayload, PushResult } from "./gateway";

/** How long a moment waits while the owner is at the Mac: long enough to answer it there, and no
 *  longer, so walking away mid-wait does not cost the answer an agent is blocked on. */
export const PUSH_HOLD_MS = 2 * 60_000;

/** The one line under a push's title, as a lock screen shows it. */
const LINE_MAX = 120;

export type PushKind = Exclude<PushPayload["kind"], "test">;

/** Which of PROTOCOL.md §4.3's kinds a relayed moment is. */
export function pushKind(n: Pick<RelayedNotification, "category" | "hint">): PushKind {
  if (n.category === "permission") return n.hint?.kind === "question" ? "question" : "permission";
  if (n.category === "session_done") return n.hint?.kind === "failed" ? "failed" : "finished";
  return "blocked";
}

/** One line, at most 120 characters, from whatever the moment said. */
export function pushLine(text: string | null | undefined): string {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length <= LINE_MAX ? line : `${line.slice(0, LINE_MAX - 1)}…`;
}

/** The collapse id: the same `(category, refId)` the feed dedupes on, hashed so the relay — and APNs —
 *  learn nothing from it, and a repeat replaces the push before it on the lock screen. */
export const collapseId = (category: NotificationCategory, refId: string): string =>
  createHash("sha256").update(`${category}:${refId}`).digest("hex");

/** Whether a moment is still worth a buzz: a request or a block nobody has answered, or a finished
 *  turn nobody has read. Gone is not waiting. */
export function stillWaiting(n: Notification | null): boolean {
  if (!n) return false;
  return n.category === "session_done" ? n.readAt === null : n.actedAt === null;
}

export type PhonePushesDeps = {
  /** The phones to seal for, and the sealing (`RemoteService`). */
  remote: {
    phones(): { phoneId: string }[];
    push(phoneId: string, payload: PushPayload, o: { urgent: boolean; collapse: string | null; badge: number | null }): Promise<PushResult>;
  };
  presence: { away(): boolean; onChange(listener: () => void): () => void };
  settings: SettingsStore;
  /** The feed row as it stands now, for the hold-back's second look. */
  notification: (id: string) => Notification | null;
  /** The badge: how many sessions are waiting on the owner. */
  needsYou: () => number;
  /** A session's title as the sidebar shows it, or null. */
  titleOf: (sessionId: string) => string | null;
  holdMs?: number;
  log?: (line: string) => void;
};

/**
 * The phone transport for `NotificationRelay` (Plan 28, "When the phone buzzes"): one sealed push per
 * paired phone, for the three moments the relay sends — and not while the owner is at the Mac.
 *
 * Away (said so, silent for five minutes, or no Realm attached), a moment goes at once. Present, it
 * waits two minutes and goes only if it is still waiting: answered on the Mac, or read there, it never
 * buzzes. A report that the owner just left sends every held moment that is still waiting, then.
 */
export class PhonePushes implements PhoneTransport {
  private readonly held = new Map<string, { n: RelayedNotification; timer: NodeJS.Timeout }>();
  private readonly offPresence: () => void;

  constructor(private readonly d: PhonePushesDeps) {
    this.offPresence = d.presence.onChange(() => { if (d.presence.away()) this.flush(); });
  }

  /** On unless switched off in Settings, and only with a phone to send to. */
  wants(): boolean {
    return this.d.settings.get(NOTIFICATIONS_IPHONE_KEY) !== false && this.d.remote.phones().length > 0;
  }

  send(n: RelayedNotification): void {
    if (this.d.presence.away()) { this.deliver(n); return; }
    const before = this.held.get(n.id);
    if (before) clearTimeout(before.timer);
    const timer = setTimeout(() => {
      this.held.delete(n.id);
      if (stillWaiting(this.d.notification(n.id))) this.deliver(n);
    }, this.d.holdMs ?? PUSH_HOLD_MS);
    timer.unref?.();
    this.held.set(n.id, { n, timer });
  }

  close(): void {
    for (const h of this.held.values()) clearTimeout(h.timer);
    this.held.clear();
    this.offPresence();
  }

  private flush(): void {
    for (const [id, h] of [...this.held]) {
      clearTimeout(h.timer);
      this.held.delete(id);
      if (stillWaiting(this.d.notification(id))) this.deliver(h.n);
    }
  }

  private deliver(n: RelayedNotification): void {
    // Asked again at the moment of sending: a switch turned off, or the last phone removed, while a
    // moment was held is a push nobody wants any more.
    if (!this.wants()) return;
    const kind = pushKind(n);
    const payload: PushPayload = {
      kind,
      title: (n.sessionId ? this.d.titleOf(n.sessionId) : null) || n.title,
      body: pushLine(n.hint?.line || n.body),
      session: n.sessionId,
    };
    const o = {
      urgent: kind === "permission" || kind === "question" || kind === "blocked",
      collapse: collapseId(n.category, n.refId ?? n.id),
      badge: this.d.needsYou(),
    };
    for (const { phoneId } of this.d.remote.phones()) {
      void this.d.remote.push(phoneId, payload, o)
        .then((r) => { if (!r.ok) this.d.log?.(`[remote] push to ${phoneId} not delivered: ${r.reason ?? r.status}`); })
        .catch((e: unknown) => this.d.log?.(`[remote] push to ${phoneId} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}
