import { sideTabsOf, type Item, type Layout, type SimulatorState, type Teammate, type TeammateState, type TeammateTaskSession, type TerminalStatus } from "@realm/contracts";
import { age } from "../code-review/code-review-model";

/** The dot a teammate or one of its sessions wears, in the session rows' vocabulary (attention.ts),
 *  and the words it is read out in: its state when that is worth a mark, else unread, else nothing. */
export function teammateMark(state: TeammateState, unread: boolean):
  { mark: "running" | "waiting_permission" | "unseen"; label: string } | null {
  if (state === "needs-you") return { mark: "waiting_permission", label: "needs you" };
  if (state === "working") return { mark: "running", label: "working" };
  return unread ? { mark: "unseen", label: "new since you were here" } : null;
}

/** A session in a teammate's list, at its depth, with how many were handed on from it. */
export type SessionNode = { session: TeammateTaskSession; depth: number; handoffs: number };

/**
 * A teammate's sessions as the list draws them: newest first at the top, and every session handed on
 * from one directly under it, one step in — and again under those. A session whose parent is not in
 * the list (capped, or another teammate's) starts a branch of its own.
 */
export function sessionTree(sessions: readonly TeammateTaskSession[]): SessionNode[] {
  const ids = new Set(sessions.map((s) => s.id));
  const kids = new Map<string, TeammateTaskSession[]>();
  for (const s of sessions) if (s.parentId && ids.has(s.parentId)) kids.set(s.parentId, [...(kids.get(s.parentId) ?? []), s]);
  const newest = (a: TeammateTaskSession, b: TeammateTaskSession) => b.updatedAt - a.updatedAt;
  const out: SessionNode[] = [];
  const walk = (s: TeammateTaskSession, depth: number) => {
    const under = [...(kids.get(s.id) ?? [])].sort(newest);
    out.push({ session: s, depth, handoffs: under.length });
    for (const k of under) walk(k, depth + 1);
  };
  for (const s of [...sessions].filter((s) => !s.parentId || !ids.has(s.parentId)).sort(newest)) walk(s, 0);
  return out;
}

/** A space's teammates as the sidebar lists them: the ones in no group at the top, then each group
 *  in the order its first teammate stands. */
export function groupTeammates(list: readonly Teammate[]): { top: Teammate[]; groups: [string, Teammate[]][] } {
  const top: Teammate[] = [];
  const groups = new Map<string, Teammate[]>();
  for (const t of list) {
    if (t.group) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
    else top.push(t);
  }
  return { top, groups: [...groups] };
}

/** A task session's title without the `<handle> - ` its teammate wrote in front of it, which the
 *  computer says with the teammate's icon instead. Only a teammate's own handle is taken off. */
export function plainTitle(title: string, handles: readonly string[]): string {
  const m = /^([\w.-]+) - (.+)$/s.exec(title);
  return m && handles.includes(m[1]!) ? m[2]! : title;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The computer's headline: "2 sessions working · 1 needs you", or that nothing is running. */
export function headline(working: number, needsYou: number): { working: string; needsYou: string | null } {
  return {
    working: working > 0 ? `${plural(working, "session", "sessions")} working` : needsYou > 0 ? "Nothing working" : "Nothing running",
    needsYou: needsYou > 0 ? `${needsYou} needs you` : null,
  };
}

/** What Stop stops, in its own label. */
export const stopLabel = (sessions: number): string => `Stop ${plural(sessions, "session", "sessions")}`;

/** Midnight before `ts`, in the person's own time. */
const dayStart = (ts: number): number => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "Today", "Yesterday", or the date: "Mon, Nov 2". */
export function dayLabel(ts: number, now: number): string {
  const days = Math.round((dayStart(now) - dayStart(ts)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(ts).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export type DoneDay = { label: string; rows: SessionNode[] };

/** Finished sessions by the day they last moved, newest first, each hand-off under the session that
 *  asked for it — on that session's day, however much later it finished. */
export function doneDays(nodes: readonly SessionNode[], now: number): DoneDay[] {
  const out: DoneDay[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.depth > 0 && last) { last.rows.push(n); continue; }
    const label = dayLabel(n.session.updatedAt, now);
    if (last?.label === label) last.rows.push(n);
    else out.push({ label, rows: [n] });
  }
  return out;
}

/** The first `cap` rows of `days`, in their days. */
export function firstRows(days: readonly DoneDay[], cap: number): DoneDay[] {
  const out: DoneDay[] = [];
  let left = cap;
  for (const d of days) {
    if (left <= 0) break;
    out.push({ label: d.label, rows: d.rows.slice(0, left) });
    left -= d.rows.length;
  }
  return out;
}

/** What today's finished sessions came to: "Today: 3 PRs merged · v2.7.2 shipped · 1 failed". */
export function todayLine(sessions: readonly TeammateTaskSession[], now: number): string | null {
  const today = sessions.filter((s) => s.state === "idle" && s.outcome && dayStart(s.updatedAt) === dayStart(now));
  const merged = today.filter((s) => s.outcome?.kind === "pr" && s.outcome.merged).length;
  const opened = today.filter((s) => s.outcome?.kind === "pr" && !s.outcome.merged).length;
  const tags = today.flatMap((s) => (s.outcome?.kind === "release" ? [s.outcome.tag] : []));
  const failed = today.filter((s) => s.outcome?.kind === "failed").length;
  const parts = [
    merged ? `${plural(merged, "PR", "PRs")} merged` : "",
    opened ? `${plural(opened, "PR", "PRs")} opened` : "",
    tags.length > 2 ? `${tags.length} releases shipped` : tags.map((t) => `${t} shipped`).join(" · "),
    failed ? `${failed} failed` : "",
  ].filter(Boolean);
  return parts.length ? `Today: ${parts.join(" · ")}` : null;
}

export type MacResourceKind = "terminal" | "build" | "server" | "simulator" | "browser";

/** Something one of a teammate's sessions holds open on this Mac. */
export type MacResource = {
  itemId: string; refId: string; kind: MacResourceKind; label: string; state: string;
  /** The session it was opened beside, whose side panel Open shows it in. */
  sessionId: string;
  /** Whether Stop (Shut down, for a device) has anything to stop. */
  live: boolean;
};

/** A terminal's command, read for what it is: a build, a dev server, or just a terminal. */
export function commandKind(command: string): "terminal" | "build" | "server" {
  if (/\b(xcodebuild|electron-builder|dist|archive|build|package)\b/.test(command)) return "build";
  if (/\b(dev|serve|server|preview|start)\b/.test(command)) return "server";
  return "terminal";
}

const SIMULATOR_WORD = { off: "Off", booting: "Booting", serving: "On", running: "On", failed: "Failed" } as const;

/**
 * The terminals, devices and browser tabs a teammate's sessions hold open: each session's side-panel
 * tabs of those kinds, on screen or kept for when it is next shown, and its own terminal (⌘J) wherever that is. A terminal says the command it
 * runs and for how long, from `terminals.list`; one Realm has no status for is just open.
 */
export function macResources(input: {
  sessionIds: readonly string[];
  items: readonly Item[];
  layout: Layout | null;
  /** The side panes of sessions not on screen, by session item (`WindowView.sidePanes`). */
  sidePanes: Readonly<Record<string, { tabs: string[] }>>;
  sessionTerminals: Readonly<Record<string, string>>;
  terminals: ReadonlyMap<string, TerminalStatus>;
  simulators: Readonly<Record<string, SimulatorState>>;
  now: number;
}): MacResource[] {
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const out: MacResource[] = [];
  for (const sessionId of input.sessionIds) {
    const owner = input.items.find((i) => i.kind === "session" && i.refId === sessionId);
    const tabs = owner ? [...(input.layout ? sideTabsOf(input.layout, owner.id) : []), ...(input.sidePanes[owner.id]?.tabs ?? [])] : [];
    const own = input.sessionTerminals[sessionId];
    const ownItem = own ? input.items.find((i) => i.kind === "terminal" && i.refId === own) : undefined;
    for (const item of [...tabs.map((id) => byId.get(id)), ownItem]) {
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      if (item.kind === "terminal") {
        const t = input.terminals.get(item.refId);
        const label = t?.command ?? item.title;
        out.push({ itemId: item.id, refId: item.refId, sessionId, kind: t?.command ? commandKind(t.command) : "terminal", label,
          state: !t ? "Open" : t.running ? `Running · ${age(t.startedAt, input.now)}` : t.exitCode === 0 ? "Finished" : "Exited",
          live: !!t?.running });
      } else if (item.kind === "simulator") {
        const status = input.simulators[item.refId]?.status ?? "off";
        out.push({ itemId: item.id, refId: item.refId, sessionId, kind: "simulator", label: item.title, state: SIMULATOR_WORD[status], live: status === "serving" || status === "running" });
      } else if (item.kind === "browser") {
        out.push({ itemId: item.id, refId: item.refId, sessionId, kind: "browser", label: item.title, state: "Browser tab", live: false });
      }
    }
  }
  return out;
}

/** The headline's second line: "1 build running · Simulator on · 2 terminals". */
export function resourcesLine(list: readonly MacResource[]): string | null {
  const running = (k: MacResourceKind) => list.filter((r) => r.kind === k && r.live).length;
  const builds = running("build");
  const servers = running("server");
  const sims = running("simulator");
  const terminals = list.filter((r) => r.kind === "terminal").length;
  const tabs = list.filter((r) => r.kind === "browser").length;
  const parts = [
    builds ? `${plural(builds, "build", "builds")} running` : "",
    servers ? `${plural(servers, "dev server", "dev servers")} up` : "",
    sims ? (sims === 1 ? "Simulator on" : `${sims} simulators on`) : "",
    terminals ? plural(terminals, "terminal", "terminals") : "",
    tabs ? plural(tabs, "browser tab", "browser tabs") : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
