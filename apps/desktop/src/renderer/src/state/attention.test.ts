import { describe, expect, it } from "vitest";
import type { SessionStatus } from "@realm/contracts";
import { attentionOf, isUnread, liveSessions, sessionMark, spaceSummary } from "./attention";
import { session } from "./store.test-fakes";

describe("isUnread", () => {
  it("is the log written past the read mark — and a session never opened has missed nothing", () => {
    expect(isUnread({ seenSeq: 3, lastEventSeq: 5 })).toBe(true);
    expect(isUnread({ seenSeq: 5, lastEventSeq: 5 })).toBe(false);
    expect(isUnread({ seenSeq: 0, lastEventSeq: 9 })).toBe(false);
  });
});

describe("attentionOf / sessionMark", () => {
  it("waiting on you, then working, then finished-and-unread; finished-and-read is nothing", () => {
    expect(attentionOf("waiting_permission", false)).toBe(0);
    expect(attentionOf("running", false)).toBe(1);
    expect(attentionOf("idle", true)).toBe(2);
    expect(attentionOf("error", true)).toBe(2);
    expect(attentionOf("ended", true)).toBe(2);
    expect(attentionOf("idle", false)).toBeNull();
    expect(attentionOf("error", false)).toBeNull();
  });

  it("a row wears its state when that is worth a mark, the unread ring otherwise — never both", () => {
    expect(sessionMark("running", true)).toEqual({ mark: "running", label: "running" });
    expect(sessionMark("error", true)).toEqual({ mark: "error", label: "error" });
    expect(sessionMark("idle", true)).toEqual({ mark: "unseen", label: "new since you were here" });
    expect(sessionMark("idle", false)).toBeNull();
    expect(sessionMark(undefined, false)).toBeNull();
  });
});

describe("liveSessions", () => {
  const rows = [
    session("read", "s2", { seenSeq: 4, lastEventSeq: 4, updatedAt: 90 }),
    session("unread", "s2", { seenSeq: 2, lastEventSeq: 6, updatedAt: 80 }),
    session("working-old", "s2", { updatedAt: 10 }),
    session("working-new", "s2", { updatedAt: 20 }),
    session("asks", "s3", { updatedAt: 5 }),
    session("forgotten", "s2", { status: "running" }),
  ];
  const status: Record<string, SessionStatus> = { read: "idle", unread: "idle", "working-old": "running", "working-new": "running", asks: "waiting_permission" };

  it("orders by what each needs from you, newest movement first within a rank, and drops the rest", () => {
    /* THE MUTANTS: sort by time alone (the question that has waited longest sinks under fresh
       work), or keep a finished session that has been read (the list fills with everything). */
    const out = liveSessions(rows, { status, space: {}, updatedAt: {} });
    expect(out.map((l) => l.session.id)).toEqual(["asks", "working-new", "working-old", "unread"]);
    expect(out.map((l) => l.attention)).toEqual([0, 1, 1, 2]);
  });

  it("reads the LIVE status, the live space and the live clock over the row's", () => {
    // A row with no live status is one the window has forgotten, and it is not drawn on its own word.
    const out = liveSessions(rows, {
      status: { ...status, "working-old": "waiting_permission" },
      space: { "working-old": "s9" },
      updatedAt: { "working-new": 1 },
    });
    expect(out.map((l) => l.session.id)).toEqual(["working-old", "asks", "working-new", "unread"]);
    expect(out.find((l) => l.session.id === "working-old")!.spaceId).toBe("s9");
    expect(out.some((l) => l.session.id === "forgotten")).toBe(false);
  });
});

describe("spaceSummary", () => {
  const live = { status: { a: "waiting_permission", b: "waiting_permission", c: "running", d: "idle", x: "running" } as Record<string, SessionStatus>,
    space: { a: "s2", b: "s2", c: "s2", d: "s2", x: "s3" } };

  it("wears the strip's signal with how many sessions it stands for, and says the whole of it in words", () => {
    // THE MUTANT: a count of every session in the room, or of every live one — "3" beside the
    // waiting dot would claim three questions when there are two.
    expect(spaceSummary("s2", "waiting_permission", live, [])).toEqual({ mark: "waiting_permission", count: 2, parts: ["2 waiting on you", "1 running"] });
    expect(spaceSummary("s3", "running", live, [])).toEqual({ mark: "running", count: 1, parts: ["1 running"] });
  });

  it("where the strip has nothing to say, an unread finish wears the ring — and a quiet room wears nothing", () => {
    const quiet = { status: { d: "idle", e: "idle" } as Record<string, SessionStatus>, space: { d: "s2", e: "s2" } };
    const unread = liveSessions([session("d", "s2", { seenSeq: 1, lastEventSeq: 3 })], { status: quiet.status, space: quiet.space, updatedAt: {} });
    expect(spaceSummary("s2", null, quiet, unread)).toEqual({ mark: "unseen", count: 1, parts: ["1 unread"] });
    expect(spaceSummary("s2", null, quiet, [])).toEqual({ mark: null, count: 0, parts: [] });
  });
});
