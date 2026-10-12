import { describe, expect, it } from "vitest";
import { isUnread, sessionMark } from "./attention";

describe("isUnread", () => {
  it("is the log written past the read mark — and a session never opened has missed nothing", () => {
    expect(isUnread({ seenSeq: 3, lastEventSeq: 5 })).toBe(true);
    expect(isUnread({ seenSeq: 5, lastEventSeq: 5 })).toBe(false);
    expect(isUnread({ seenSeq: 0, lastEventSeq: 9 })).toBe(false);
  });
});

describe("sessionMark", () => {
  it("a row wears its state when that is worth a mark, the unread ring otherwise — never both", () => {
    expect(sessionMark("running", true)).toEqual({ mark: "running", label: "running" });
    expect(sessionMark("error", true)).toEqual({ mark: "error", label: "error" });
    expect(sessionMark("idle", true)).toEqual({ mark: "unseen", label: "new since you were here" });
    expect(sessionMark("idle", false)).toBeNull();
    expect(sessionMark(undefined, false)).toBeNull();
  });
});

