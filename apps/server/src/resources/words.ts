import type { Session } from "@realm/contracts";

/** "4 min", "2 h": how long, in the words the Memory page and the tool both use. */
export function durationWords(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return "under a minute";
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/** "1.2 GB", "300 MB". */
export const gb = (bytes: number): string => {
  const g = bytes / 1024 ** 3;
  return g >= 1 ? `${g >= 10 ? Math.round(g) : (Math.round(g * 10) / 10).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
};

/** What an engine is doing, as its row says it: working, waiting on you, or idle since its last event. */
export function engineDetail(e: { status: Session["status"]; lastActiveAt: number }, now: number): string {
  if (e.status === "running") return "Working";
  if (e.status === "waiting_permission") return "Waiting on you";
  return `Idle ${durationWords(now - e.lastActiveAt)}`;
}
