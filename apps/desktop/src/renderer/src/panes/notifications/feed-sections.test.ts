import { describe, expect, it } from "vitest";
import type { Notification, NotificationCategory } from "@realm/contracts";
import { feedSections, sectionLabel } from "./feed-sections";

let n = 0;
const row = (over: Partial<Notification> & { category?: NotificationCategory } = {}): Notification => ({
  id: `n${++n}`, category: "session_done", title: "t", body: null, sessionId: null, spaceId: null,
  refId: null, readAt: null, actedAt: null, createdAt: 1_000, ...over,
} as Notification);

const dayLabel = (ts: number) => (ts >= 1_000 ? "Today" : "Yesterday");
const cut = (rows: Notification[], detachedSince: number | null = null) => feedSections(rows, { detachedSince, dayLabel });

describe("feedSections", () => {
  it("pins what is waiting on you, permissions before blocked runs", () => {
    const perm = row({ category: "permission" });
    const blocked = row({ category: "run_blocked" });
    const done = row({ category: "session_done" });
    // Feed order is newest-first and deliberately NOT the pinned order: a blocked run that arrived
    // later still comes after the permission somebody is stopped behind.
    const s = cut([blocked, done, perm]);
    expect(s[0]).toEqual({ kind: "needs-you", rows: [perm, blocked] });
    expect(s[1]).toMatchObject({ kind: "day", rows: [done] });
  });

  it("drops a row from the pin the moment the world resolves it, not when it is read", () => {
    // `readAt` is about a person having looked; `actedAt` is about the permission being answered. A
    // row somebody merely read is still a question an agent is stopped behind.
    const readButPending = row({ category: "permission", readAt: 5 });
    expect(cut([readButPending])[0]).toMatchObject({ kind: "needs-you" });
    const answered = row({ category: "permission", actedAt: 5 });
    expect(cut([answered])[0]).toMatchObject({ kind: "day" });
  });

  it("never shows a row twice — a duplicated row would make the page lie about how much is waiting", () => {
    const perm = row({ category: "permission", createdAt: 9_000 });
    const done = row({ category: "session_done", createdAt: 9_000 });
    const ids = cut([perm, done], 5_000).flatMap((s) => s.rows.map((r) => r.id));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("renders nothing extra when nothing has happened while away", () => {
    const s = cut([row(), row()], null);
    expect(s.map((x) => x.kind)).toEqual(["day"]);
  });

  it("cuts 'while you were away' at the moment the window closed, exclusive", () => {
    const atTheMoment = row({ createdAt: 5_000 });
    const after = row({ createdAt: 5_001 });
    const s = cut([after, atTheMoment], 5_000);
    expect(s[0]).toEqual({ kind: "away", rows: [after] });
    // The row written at the instant the window closed is one you were there for.
    expect(s[1]).toMatchObject({ kind: "day", rows: [atTheMoment] });
  });

  it("groups the remainder by day, in feed order", () => {
    const today = row({ createdAt: 2_000 });
    const earlier = row({ createdAt: 10 });
    const s = cut([today, earlier]);
    expect(s.map(sectionLabel)).toEqual(["Today", "Yesterday"]);
  });

  it("counts only the section whose count is the point", () => {
    expect(sectionLabel({ kind: "needs-you", rows: [row()] })).toBe("Needs you");
    expect(sectionLabel({ kind: "needs-you", rows: [row(), row()] })).toBe("Needs you · 2");
    expect(sectionLabel({ kind: "away", rows: [row(), row()] })).toBe("While you were away");
  });
});
