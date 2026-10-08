import { describe, expect, it } from "vitest";
import type { Item, Session, SessionStatus } from "@realm/contracts";
import { item, profile, session, space } from "../../state/store.test-fakes";
import {
  agentsWaiting, attentionRank, FAN_OUT_GAP_MS, listedSessions, needsYou, orderSpaces, pinnedItems, profileWaiting, recentDays, reorderWithin,
  rowsBySpace, sectionView, spaceRows, spaceTally, tallyOf, tallyWords, type SessionRow, type SidebarState,
} from "./model";

const NOW = new Date(2026, 9, 4, 15, 0).getTime();
const MIN = 60_000;

/** A home: two profiles, Work (Homework, Thesis) and School (Lectures). The window shows Work, so its
 *  own lists carry both of Work's spaces; Homework holds the session in focus. */
function home(over: Partial<SidebarState> = {}): SidebarState {
  return {
    spaces: [space("hw", "p1", "Homework"), space("th", "p1", "Thesis"), space("lec", "p2", "Lectures")],
    profiles: [profile("p1", "Work"), profile("p2", "School")],
    activeProfileId: "p1",
    activeSpaceId: "hw",
    items: [], allItems: [], sessions: {}, allSessions: {}, sessionStatus: {}, sessionSpace: {}, sessionUpdatedAt: {},
    quickChatId: null,
    ...over,
  };
}

/** A session with its item, its live status and its place in the maps, as the store holds them. */
function seed(rows: { id: string; space: string; status?: SessionStatus; at?: number; title?: string; item?: Partial<Item>; session?: Partial<Session> }[], over: Partial<SidebarState> = {}): SidebarState {
  const s = home(over);
  const items: Item[] = []; const allItems: Item[] = [];
  const allSessions: Record<string, Session> = {}; const sessionStatus: Record<string, SessionStatus> = {};
  const sessionSpace: Record<string, string> = {}; const sessionUpdatedAt: Record<string, number> = {};
  for (const r of rows) {
    const at = r.at ?? NOW;
    const row = session(r.id, r.space, { title: r.title ?? `session ${r.id}`, status: r.status ?? "idle", updatedAt: at, createdAt: at, ...r.session });
    allSessions[r.id] = row;
    sessionStatus[r.id] = row.status; sessionSpace[r.id] = r.space; sessionUpdatedAt[r.id] = at;
    const it = item(`i-${r.id}`, r.space, { kind: "session", refId: r.id, title: r.title ?? `session ${r.id}`, ...r.item });
    if (s.spaces.find((sp) => sp.id === r.space)?.profileId === s.activeProfileId) items.push(it);
    if (!it.archived) allItems.push(it);
  }
  return { ...s, items, allItems, allSessions, sessionStatus, sessionSpace, sessionUpdatedAt, ...over };
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("listedSessions — what the sidebar lists as a row", () => {
  it("lists every session item, in the room on screen and in every other space", () => {
    const s = seed([{ id: "a", space: "hw" }, { id: "b", space: "th" }, { id: "c", space: "lec" }]);
    expect(ids(listedSessions(s)).sort()).toEqual(["a", "b", "c"]);
  });

  it("names a row by its ITEM, which is what a rename changes", () => {
    const s = seed([{ id: "a", space: "th", title: "Old", item: { title: "Renamed" } }]);
    expect(listedSessions(s)[0]!.title).toBe("Renamed");
  });

  it("leaves out an archived session — it is on its space's page", () => {
    const s = seed([{ id: "a", space: "hw", item: { archived: true } }, { id: "b", space: "hw" }]);
    expect(ids(listedSessions(s))).toEqual(["b"]);
  });

  it("leaves out a sub-agent: it is listed under its lead's running-agents control", () => {
    const s = seed([{ id: "lead", space: "hw" }, { id: "kid", space: "hw", session: { dispatchedBy: { kind: "agent_run", sessionId: "lead" } } }]);
    expect(ids(listedSessions(s))).toEqual(["lead"]);
  });

  it("keeps a sub-agent under an archived lead put away with it, and lists one whose lead is gone", () => {
    // The space's Sessions page nests the same way (`nestChildren`), so its Active count is this list's.
    const s = seed([
      { id: "shelved", space: "hw", item: { archived: true } },
      { id: "kid", space: "hw", session: { dispatchedBy: { kind: "agent_run", sessionId: "shelved" } } },
      { id: "orphan", space: "hw", session: { dispatchedBy: { kind: "agent_run", sessionId: "deleted" } } },
    ]);
    expect(ids(listedSessions(s))).toEqual(["orphan"]);
  });

  it("keeps a fork and an import — sessions the user owns, whatever started them", () => {
    const s = seed([{ id: "f", space: "hw", session: { dispatchedBy: { kind: "fork", sessionId: "x" } } }]);
    expect(ids(listedSessions(s))).toEqual(["f"]);
  });

  it("leaves out the quick chat and every item that is not a session", () => {
    const s = seed([{ id: "q", space: "hw" }, { id: "a", space: "hw" }], { quickChatId: "q" });
    const withTerminal = { ...s, items: [...s.items, item("t1", "hw", { kind: "terminal" })] };
    expect(ids(listedSessions(withTerminal))).toEqual(["a"]);
  });

  it("marks a schedule's session, so its row can wear the clock", () => {
    const s = seed([{ id: "r", space: "hw", session: { dispatchedBy: { kind: "run", sessionId: null } } }, { id: "a", space: "hw" }]);
    expect(listedSessions(s).map((r) => [r.id, r.scheduled])).toEqual([["r", true], ["a", false]]);
  });

  it("reads the LIVE status, space and activity, never the row's", () => {
    const s = seed([{ id: "a", space: "th", status: "idle", at: 1 }]);
    const live = { ...s, sessionStatus: { a: "running" as const }, sessionSpace: { a: "lec" }, sessionUpdatedAt: { a: 99 } };
    expect(listedSessions(live)[0]).toMatchObject({ status: "running", spaceId: "lec", at: 99 });
  });

  it("is unread only when read once and written past since", () => {
    const s = seed([{ id: "a", space: "hw", session: { seenSeq: 3, lastEventSeq: 5 } }, { id: "b", space: "hw", session: { seenSeq: 5, lastEventSeq: 5 } }]);
    expect(listedSessions(s).map((r) => [r.id, r.unread])).toEqual([["a", true], ["b", false]]);
  });
});

describe("spaceRows — one space's list", () => {
  it("is newest first, by last activity", () => {
    const s = seed([{ id: "old", space: "hw", at: NOW - 3 * MIN }, { id: "new", space: "hw", at: NOW }, { id: "mid", space: "hw", at: NOW - MIN }]);
    expect(ids(spaceRows(listedSessions(s)))).toEqual(["new", "mid", "old"]);
  });

  it("puts what needs you first, then what is working, then what is new — newest first within each", () => {
    // THE MUTANT: recency alone. A session working since this morning last moved this morning, and
    // would sit under Show more behind every idle session touched since.
    const s = seed([
      { id: "idle-new", space: "hw", at: NOW },
      { id: "working", space: "hw", status: "running", at: NOW - 60 * MIN },
      { id: "news", space: "hw", at: NOW - 30 * MIN, session: { seenSeq: 1, lastEventSeq: 3 } },
      { id: "asks", space: "hw", status: "waiting_permission", at: NOW - 90 * MIN },
      { id: "broke", space: "hw", status: "error", at: NOW - 10 * MIN },
      { id: "idle-old", space: "hw", at: NOW - 120 * MIN },
    ]);
    expect(ids(spaceRows(listedSessions(s)))).toEqual(["broke", "asks", "working", "news", "idle-new", "idle-old"]);
  });

  const dispatched = (id: string, created: number, extra: Partial<Session> = {}) =>
    ({ id, space: "hw", at: created, session: { dispatchedBy: { kind: "user-dispatch" as const, sessionId: null }, createdAt: created, ...extra } });

  it("folds a fan-out into ONE row, titled from its first session, with their states summed", () => {
    const s = seed([
      dispatched("f1", NOW - 10_000), dispatched("f2", NOW - 8_000), dispatched("f3", NOW - 5_000),
      { id: "solo", space: "hw", at: NOW - 60 * MIN },
    ]);
    const live = { ...s, sessionStatus: { ...s.sessionStatus, f1: "running" as const, f2: "waiting_permission" as const, f3: "running" as const } };
    const rows = spaceRows(listedSessions(live));
    expect(rows.map((r) => r.kind)).toEqual(["fan-out", "session"]);
    const fan = rows[0]!;
    if (fan.kind !== "fan-out") throw new Error("not a fan-out");
    expect(fan.title).toBe("session f1");
    expect(ids(fan.sessions)).toEqual(["f3", "f2", "f1"]);
    expect(fan.tally).toEqual({ waiting: 1, running: 2, failed: 0, unread: 0 });
  });

  it("ranks a fan-out by its most urgent session", () => {
    const s = seed([dispatched("f1", NOW - 50 * MIN), dispatched("f2", NOW - 49 * MIN), { id: "x", space: "hw", at: NOW }]);
    const asking = { ...s, sessionStatus: { ...s.sessionStatus, f2: "waiting_permission" as const } };
    const rows = spaceRows(listedSessions(asking));
    expect(rows.map((r) => [r.kind, attentionRank(r)])).toEqual([["fan-out", 0], ["session", 3]]);
  });

  it("leaves one dispatched session a row of its own", () => {
    const rows = spaceRows(listedSessions(seed([dispatched("d", NOW)])));
    expect(rows.map((r) => r.kind)).toEqual(["session"]);
  });

  it("does not fold two dispatches made further apart than a fan-out makes them", () => {
    const rows = spaceRows(listedSessions(seed([dispatched("a", NOW - FAN_OUT_GAP_MS - 1), dispatched("b", NOW)])));
    expect(rows.map((r) => r.kind)).toEqual(["session", "session"]);
  });

  it("does not fold two agent kinds — one fan-out runs one agent", () => {
    const rows = spaceRows(listedSessions(seed([dispatched("a", NOW - 1000, { agentKind: "claude" }), dispatched("b", NOW, { agentKind: "codex" })])));
    expect(rows.map((r) => r.kind)).toEqual(["session", "session"]);
  });

  it("does not fold sessions the user made by hand, however close together", () => {
    const rows = spaceRows(listedSessions(seed([{ id: "a", space: "hw", at: NOW - 1000 }, { id: "b", space: "hw", at: NOW }])));
    expect(rows.map((r) => r.kind)).toEqual(["session", "session"]);
  });

  it("sorts a fan-out by its newest session's activity", () => {
    const s = seed([dispatched("f1", NOW - 50 * MIN), dispatched("f2", NOW - 49 * MIN), { id: "x", space: "hw", at: NOW - 10 * MIN }]);
    const moved = { ...s, sessionUpdatedAt: { ...s.sessionUpdatedAt, f1: NOW } };
    expect(spaceRows(listedSessions(moved)).map((r) => r.kind)).toEqual(["fan-out", "session"]);
  });

  it("keeps each space's rows to itself", () => {
    const by = rowsBySpace(listedSessions(seed([{ id: "a", space: "hw" }, { id: "b", space: "th" }])));
    expect(ids(by.get("hw")!)).toEqual(["a"]);
    expect(ids(by.get("th")!)).toEqual(["b"]);
  });
});

describe("sectionView", () => {
  it("shows five rows and counts the rest behind Show more", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}` }) as SessionRow);
    const view = sectionView(rows);
    expect(view.shown).toHaveLength(5);
    expect(view.hidden).toBe(3);
  });

  it("has nothing behind Show more for a short space", () => {
    expect(sectionView([{ id: "a" } as SessionRow]).hidden).toBe(0);
  });
});

describe("a space's tally", () => {
  it("counts every session working in the space, a sub-agent's included", () => {
    const s = seed([
      { id: "w", space: "hw", status: "waiting_permission" }, { id: "r", space: "hw", status: "running" },
      { id: "kid", space: "hw", status: "running", session: { dispatchedBy: { kind: "agent_run", sessionId: "r" } } },
      { id: "e", space: "hw", status: "error" }, { id: "elsewhere", space: "th", status: "running" },
    ]);
    expect(spaceTally(s, "hw", listedSessions(s))).toEqual({ waiting: 1, running: 2, failed: 1, unread: 0 });
  });

  it("counts unread only on a row with nothing louder to show", () => {
    const s = seed([
      { id: "u", space: "hw", session: { seenSeq: 1, lastEventSeq: 4 } },
      { id: "busy", space: "hw", status: "running", session: { seenSeq: 1, lastEventSeq: 4 } },
    ]);
    expect(spaceTally(s, "hw", listedSessions(s))).toMatchObject({ running: 1, unread: 1 });
  });

  it("leaves the quick chat out", () => {
    const s = seed([{ id: "q", space: "hw", status: "running" }], { quickChatId: "q" });
    expect(spaceTally(s, "hw", listedSessions(s)).running).toBe(0);
  });

  it("says itself in words, most urgent first", () => {
    expect(tallyWords({ waiting: 2, running: 3, failed: 1, unread: 1 })).toEqual(["2 waiting on you", "1 failed", "3 running", "1 unread"]);
    expect(tallyWords(tallyOf([]))).toEqual([]);
  });
});

describe("needsYou — the one list of what waits on you", () => {
  it("lists what waits across every space and profile, the longest-waiting first, then what failed", () => {
    const s = seed([
      { id: "late", space: "hw", status: "waiting_permission", at: NOW - MIN },
      { id: "early", space: "lec", status: "waiting_permission", at: NOW - 10 * MIN },
      { id: "broke", space: "th", status: "error", at: NOW - 20 * MIN },
      { id: "busy", space: "hw", status: "running" },
    ]);
    expect(needsYou(s).map((r) => [r.session.id, r.status])).toEqual([["early", "waiting_permission"], ["late", "waiting_permission"], ["broke", "error"]]);
  });

  it("lists a failure only until it is read", () => {
    const s = seed([
      { id: "new-fail", space: "hw", status: "error", session: { seenSeq: 2, lastEventSeq: 6 } },
      { id: "never-opened", space: "hw", status: "error", session: { seenSeq: 0, lastEventSeq: 6 } },
      { id: "seen-fail", space: "hw", status: "error", session: { seenSeq: 6, lastEventSeq: 6 } },
    ]);
    expect(needsYou(s).map((r) => r.session.id).sort()).toEqual(["never-opened", "new-fail"]);
  });

  it("lists a sub-agent's question — it blocks its lead — but not its failure, which its lead hears", () => {
    const child = { dispatchedBy: { kind: "agent_run" as const, sessionId: "lead" } };
    const s = seed([{ id: "asks", space: "hw", status: "waiting_permission", session: child }, { id: "fails", space: "hw", status: "error", session: child }]);
    expect(needsYou(s).map((r) => r.session.id)).toEqual(["asks"]);
  });

  it("lists an archived session's question, and leaves its failure put away", () => {
    const s = seed([
      { id: "asks", space: "hw", status: "waiting_permission", item: { archived: true } },
      { id: "fails", space: "hw", status: "error", item: { archived: true } },
    ]);
    expect(needsYou(s).map((r) => r.session.id)).toEqual(["asks"]);
  });

  it("leaves out the quick chat, whose own window shows its question", () => {
    const s = seed([{ id: "q", space: "hw", status: "waiting_permission" }], { quickChatId: "q" });
    expect(needsYou(s)).toEqual([]);
  });

  it("names the row by its item, and files it under its live space", () => {
    const s = seed([{ id: "a", space: "th", status: "waiting_permission", title: "Session", item: { title: "Wants a yes" } }]);
    const moved = { ...s, sessionSpace: { a: "lec" } };
    expect(needsYou(moved)[0]).toMatchObject({ title: "Wants a yes", spaceId: "lec" });
  });
});

describe("counts", () => {
  it("counts each profile's waiting sessions for the switcher", () => {
    const s = seed([
      { id: "a", space: "hw", status: "waiting_permission" }, { id: "b", space: "th", status: "waiting_permission" },
      { id: "c", space: "lec", status: "waiting_permission" }, { id: "d", space: "lec", status: "running" },
    ]);
    expect(profileWaiting(s, "p1")).toBe(2);
    expect(profileWaiting(s, "p2")).toBe(1);
  });
});

describe("pinnedItems", () => {
  it("lists the profile's pinned items across its spaces, in the spaces' order, then their own", () => {
    // The window's list carries every Work space; allItems repeats one of them, adds School's, and
    // still holds a Homework row this window has deleted since — which must not come back.
    const s = home({
      items: [item("hw-b", "hw", { pinned: true, sortOrder: 2 }), item("hw-a", "hw", { pinned: true, sortOrder: 1 }), item("hw-c", "hw"),
        item("th-a", "th", { pinned: true, sortOrder: 5 })],
      allItems: [item("th-a", "th", { pinned: true, sortOrder: 5 }), item("lec-a", "lec", { pinned: true }), item("hw-stale", "hw", { pinned: true })],
    });
    const profileSpaces = s.spaces.filter((sp) => sp.profileId === "p1");
    expect(pinnedItems(s, [...profileSpaces].reverse()).map((i) => i.id)).toEqual(["th-a", "hw-a", "hw-b"]);
  });

  it("leaves out an archived pin", () => {
    const s = home({ items: [item("a", "hw", { pinned: true, archived: true })] });
    expect(pinnedItems(s, s.spaces)).toEqual([]);
  });
});

describe("section order", () => {
  it("keeps the order the spaces were arranged in, until activity order is asked for", () => {
    const s = seed([{ id: "x", space: "th", status: "waiting_permission" }]);
    const mine = s.spaces.filter((sp) => sp.profileId === "p1");
    expect(orderSpaces(mine, false, s).map((sp) => sp.id)).toEqual(["hw", "th"]);
    expect(orderSpaces(mine, true, s).map((sp) => sp.id)).toEqual(["th", "hw"]);
  });

  it("rewrites only the dragged profile's slots in the home's order", () => {
    const all = [space("a", "p1", "A"), space("x", "p2", "X"), space("b", "p1", "B"), space("c", "p1", "C")];
    const mine = all.filter((sp) => sp.profileId === "p1");
    expect(reorderWithin(all, mine, "a", "c")).toEqual(["b", "x", "c", "a"]);
    expect(reorderWithin(all, mine, "a", "a")).toBeNull();
  });
});

describe("recentDays — every session by time", () => {
  it("counts a session still at work as active now, whenever its status last moved", () => {
    const yesterday = NOW - 24 * 60 * MIN;
    const s = seed([{ id: "since-yesterday", space: "hw", status: "running", at: yesterday }, { id: "done", space: "hw", at: yesterday }]);
    const days = recentDays(listedSessions(s), NOW);
    expect(days.map((d) => [d.label, d.rows.map((r) => r.id)])).toEqual([["Today", ["since-yesterday"]], ["Yesterday", ["done"]]]);
  });

  it("cuts the profile's rows into days, newest first, a fan-out still one row", () => {
    const yesterday = NOW - 24 * 60 * MIN;
    const s = seed([
      { id: "today", space: "hw", at: NOW - MIN },
      { id: "f1", space: "th", at: yesterday, session: { dispatchedBy: { kind: "user-dispatch", sessionId: null }, createdAt: yesterday } },
      { id: "f2", space: "th", at: yesterday + 1000, session: { dispatchedBy: { kind: "user-dispatch", sessionId: null }, createdAt: yesterday + 1000 } },
    ]);
    const days = recentDays(listedSessions(s), NOW);
    expect(days.map((d) => d.label)).toEqual(["Today", "Yesterday"]);
    expect(days[0]!.rows.map((r) => r.id)).toEqual(["today"]);
    expect(days[1]!.rows.map((r) => r.kind)).toEqual(["fan-out"]);
  });
});

describe("a sub-agent's request rolls up onto its lead", () => {
  const child = (lead: string) => ({ dispatchedBy: { kind: "agent_run" as const, sessionId: lead } });
  /** "lead" in Homework, with two sub-agents waiting — one of them an older build's grandchild — and
   *  one working; "orphan" is a waiting sub-agent whose lead this window does not hold. */
  const s = () => seed([
    { id: "lead", space: "hw", status: "idle", at: NOW - 30 * MIN },
    { id: "own", space: "hw", status: "waiting_permission", at: NOW - 2 * MIN },
    { id: "k1", space: "hw", status: "waiting_permission", at: NOW - 3 * MIN, session: child("lead") },
    { id: "k2", space: "hw", status: "running", session: child("lead") },
    { id: "g1", space: "hw", status: "waiting_permission", at: NOW - 5 * MIN, session: child("k2") },
    { id: "orphan", space: "hw", status: "waiting_permission", at: NOW - MIN, session: child("gone") },
    { id: "quiet", space: "hw", status: "idle", at: NOW },
  ]);

  it("a waiting sub-agent of a listed lead is not a Needs you row; a lead's own request still is", () => {
    // THE MUTANT: the old needsYou — one row per waiting child, at the top of the sidebar.
    expect(needsYou(s()).map((r) => r.session.id).sort()).toEqual(["orphan", "own"]);
  });

  it("a waiting sub-agent whose lead this window does not hold keeps its own row — no request is lost", () => {
    // THE MUTANT: drop every waiting child — "orphan"'s request would be nowhere in the sidebar.
    expect(needsYou(s()).map((r) => r.session.id)).toContain("orphan");
  });

  it("counts per ROOT lead, across an older build's grandchild, and names the one that has waited longest", () => {
    // THE MUTANT: count under the immediate parent — g1 would land on k2, which has no row.
    expect(agentsWaiting(s()).get("lead")).toMatchObject({ count: 2, first: "g1" });
    const row = listedSessions(s()).find((r) => r.id === "lead")!;
    expect(row).toMatchObject({ agentsWaiting: 2, firstWaiting: "g1" });
  });

  it("puts a lead whose sub-agents wait at the top of its space, with what waits on you itself", () => {
    // THE MUTANT: rank a lead by its own status alone — idle, and under the newer quiet session.
    const rows = rowsBySpace(listedSessions(s())).get("hw")!;
    expect(attentionRank(rows.find((r) => r.id === "lead")!)).toBe(0);
    expect(rows.map((r) => r.id).indexOf("lead")).toBeLessThan(rows.map((r) => r.id).indexOf("quiet"));
  });
});
