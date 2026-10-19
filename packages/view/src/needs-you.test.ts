import { describe, expect, it } from "vitest";
import type { Item, Session, Space } from "@realm/contracts";
import { needsYou, quickChatIdOf, type NeedsYouState } from "./needs-you";

/**
 * Needs you, as both its readers run it. The renderer's own tests hold the sidebar to it through its
 * store (components/sidebar/model.test.ts, needs-you.test.tsx); these hold it to the input a server
 * builds, with no window: no active profile, no window-held items, every row from the lists.
 */

const space = (id: string, profileId = "p1"): Space =>
  ({ id, profileId, name: id, icon: "folder", color: "#7c6cff", sortOrder: 0, folderPath: "/tmp", groups: null, layout: null, activeItemId: null, createdAt: 0, updatedAt: 0 });
const item = (refId: string, spaceId: string, title: string, extra: Partial<Item> = {}): Item =>
  ({ id: `i-${refId}`, spaceId, kind: "session", title, sortOrder: 0, pinned: false, archived: false, refId, createdAt: 0, updatedAt: 0, ...extra });
const session = (id: string, spaceId: string, extra: Partial<Session> = {}): Session =>
  ({ id, spaceId, projectId: null, agentKind: "fake", model: null, effort: null, fastMode: false, permissionMode: "default", environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", cwd: "/tmp", status: "idle",
    providerSessionId: null, title: `${id} (session)`, lastEventSeq: 0, seenSeq: 0, terminalItemId: null, dispatchedBy: null, activityAt: 0, createdAt: 0, updatedAt: 0, ...extra });

/** The input as realm-server builds it from `spaces.list`, `sessions.listAll` and `items.listAll`. */
function served(o: { spaces?: Space[]; sessions: Session[]; items: Item[]; quickChatId?: string | null }): NeedsYouState {
  const by = <T>(f: (s: Session) => T) => Object.fromEntries(o.sessions.map((s) => [s.id, f(s)]));
  return {
    spaces: o.spaces ?? [space("s1"), space("s2", "p2")], activeProfileId: null, items: [], allItems: o.items.filter((i) => !i.archived),
    sessions: {}, allSessions: by((s) => s), sessionStatus: by((s) => s.status), sessionSpace: by((s) => s.spaceId),
    sessionUpdatedAt: by((s) => s.updatedAt), quickChatId: o.quickChatId ?? null,
  };
}
const ids = (s: NeedsYouState) => needsYou(s).map((r) => r.session.id);

describe("needsYou, from a server's lists", () => {
  it("lists what waits across every profile, the longest-waiting first, then what failed", () => {
    const s = served({
      sessions: [
        session("late", "s1", { status: "waiting_permission", updatedAt: 30 }),
        session("failed", "s2", { status: "error", updatedAt: 1, lastEventSeq: 4 }),
        session("early", "s2", { status: "waiting_permission", updatedAt: 10 }),
        session("idle", "s1"), session("running", "s1", { status: "running" }),
      ],
      items: [item("late", "s1", "Late"), item("failed", "s2", "Failed"), item("early", "s2", "Early"), item("idle", "s1", "Idle"), item("running", "s1", "Running")],
    });
    // THE MUTANT: order by anything but how long each has waited — `b.since - a.since` reverses it.
    expect(ids(s)).toEqual(["early", "late", "failed"]);
    expect(needsYou(s).map((r) => [r.title, r.spaceId, r.status])).toEqual([["Early", "s2", "waiting_permission"], ["Late", "s1", "waiting_permission"], ["Failed", "s2", "error"]]);
  });

  it("leaves out the quick chat, whose own window shows its question", () => {
    const s = served({ sessions: [session("qc", "s1", { status: "waiting_permission" }), session("asks", "s1", { status: "waiting_permission" })], items: [item("asks", "s1", "Asks")], quickChatId: "qc" });
    // THE MUTANT: drop the quick chat's id from the input, and its question is listed twice over.
    expect(ids(s)).toEqual(["asks"]);
  });

  it("rolls a sub-agent's question onto a listed lead, and lists one whose lead is put away or gone", () => {
    const child = (id: string, lead: string) => session(id, "s1", { status: "waiting_permission", dispatchedBy: { kind: "agent_run", sessionId: lead } });
    const s = served({
      sessions: [session("lead", "s1"), child("under-lead", "lead"), session("archived-lead", "s1"), child("under-archived", "archived-lead"), child("orphan", "deleted")],
      items: [item("lead", "s1", "Lead"), item("under-lead", "s1", "Child"), item("archived-lead", "s1", "Put away", { archived: true }), item("under-archived", "s1", "Child 2")],
    });
    expect(ids(s)).toEqual(["under-archived", "orphan"]);
  });

  it("lists a failure until it is read, and only one the person owns", () => {
    const failed = (id: string, extra: Partial<Session> = {}) => session(id, "s1", { status: "error", lastEventSeq: 9, ...extra });
    const s = served({
      sessions: [
        failed("never-opened"), failed("read", { seenSeq: 9 }), failed("unread-since", { seenSeq: 5 }), failed("archived"),
        failed("child", { dispatchedBy: { kind: "agent_run", sessionId: "never-opened" } }),
      ],
      items: ["never-opened", "read", "unread-since", "child"].map((id) => item(id, "s1", id)).concat(item("archived", "s1", "archived", { archived: true })),
    });
    // THE MUTANT: count a failure read on the Mac as unread — `seenSeq > 0 && lastEventSeq < seenSeq`
    // brings "read" back.
    expect(ids(s)).toEqual(["never-opened", "unread-since"]);
  });

  it("names a row by its item, or by its session where it has none", () => {
    const s = served({ sessions: [session("titled", "s1", { status: "waiting_permission", updatedAt: 1 }), session("bare", "s1", { status: "waiting_permission", updatedAt: 2 })], items: [item("titled", "s1", "Renamed")] });
    expect(needsYou(s).map((r) => r.title)).toEqual(["Renamed", "bare (session)"]);
  });
});

describe("quickChatIdOf", () => {
  it("reads the session id the quick chat's setting holds, and nothing else", () => {
    expect(quickChatIdOf({ sessionId: "01J", pos: { x: 1, y: 2 } })).toBe("01J");
    expect(quickChatIdOf({ sessionId: null, pos: null })).toBeNull();
    expect(quickChatIdOf({ sessionId: "" })).toBeNull();
    expect(quickChatIdOf(null)).toBeNull();
    expect(quickChatIdOf("01J")).toBeNull();
  });
});
