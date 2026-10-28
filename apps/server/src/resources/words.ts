import type { Session } from "@realm/contracts";

/** "4 min", "2 h": how long, in the words the Memory page and the tool both use. */
export function durationWords(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return "under a minute";
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/** What an engine is doing, as its row says it: working, waiting on you, or idle since its last event. */
export function engineDetail(e: { status: Session["status"]; lastActiveAt: number }, now: number): string {
  if (e.status === "running") return "Working";
  if (e.status === "waiting_permission") return "Waiting on you";
  return `Idle ${durationWords(now - e.lastActiveAt)}`;
}
