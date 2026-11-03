import { describe, expect, it } from "vitest";
import { PERSISTED_EVENT_TYPES, SessionEventSchema } from "./session-events";
import { SessionStatusSchema } from "./entities";
import { MoveOptionsSchema, MoveTargetSchema, movedSentence, placeName } from "./session-move";
import { Methods } from "./rpc";

const place = { machine: null, environmentId: "01J00000000000000000000000", cwd: "/repo", branch: "main" };

describe("session move contracts", () => {
  it("keeps a move's progress and how it ended", () => {
    expect(PERSISTED_EVENT_TYPES).toEqual(expect.arrayContaining(["moving", "moved", "move_failed"]));
  });

  it("parses each move event", () => {
    const moved = { type: "moved", ts: 1, payload: { moveId: "m", from: place, to: { ...place, cwd: "/wt" }, conversation: "native", changedFiles: 2, leftBehind: ["the terminal"], preface: "p", note: "n" } };
    expect(SessionEventSchema.parse(moved)).toEqual(moved);
    expect(SessionEventSchema.safeParse({ type: "move_failed", ts: 1, payload: { moveId: "m", step: "place", reason: "r", note: "n" } }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ type: "moving", ts: 1, payload: { moveId: "m", step: "sending" } }).success).toBe(false);
  });

  it("adds moving to the session statuses", () => {
    expect(SessionStatusSchema.options).toContain("moving");
  });

  it("defaults a move to now, leaving the source's changes", () => {
    const p = Methods["sessions.move"].params.parse({ id: place.environmentId, to: { kind: "worktree" } });
    expect(p).toMatchObject({ keepSourceChanges: true, when: "now" });
    expect(MoveTargetSchema.safeParse({ kind: "server", serverId: "x" }).success).toBe(false);
  });

  it("reads options, queues and places from before the machine name, the kind and the pending move", () => {
    const options = { from: place, busy: false, blocked: null, pending: false, conversation: "native", changedFiles: 0, leftBehind: [], environments: [], worktree: { available: true, reason: null } };
    expect(MoveOptionsSchema.safeParse(options).success).toBe(true);
    expect(MoveOptionsSchema.parse({ ...options, machineName: "Mac mini", from: { ...place, kind: "worktree" }, move: { moveId: "m", to: { kind: "worktree" }, step: null } }))
      .toMatchObject({ machineName: "Mac mini", from: { kind: "worktree" }, move: { step: null } });
    expect(Methods["sessions.queued"].result.safeParse({ queued: [] }).success).toBe(true);
    expect(Methods["sessions.queued"].result.parse({ queued: [], move: { moveId: "m", to: { kind: "worktree" }, step: "place" } }).move?.step).toBe("place");
  });
});

describe("naming the ends of a move", () => {
  const at = (cwd: string, branch: string | null) => ({ cwd, branch });

  it("names a checkout by its folder and branch", () => {
    expect(placeName(at("/Users/me/shop", "main"))).toBe("shop (main)");
    expect(placeName(at("/Users/me/shop", null))).toBe("shop");
  });

  it("says the moved line without a path in it", () => {
    expect(movedSentence({ from: at("/Users/me/shop", "main"), to: at("/Users/me/Realm/worktrees/01M6HDE0JV8Y1B2DVQZN8B29YC/fix-tests", "realm/fix-tests"), conversation: "native" }))
      .toBe("Moved from shop (main) to fix-tests (realm/fix-tests). The conversation continued.");
    expect(movedSentence({ from: at("/a/shop", null), to: at("/b/shop-2", null), conversation: "notes" }))
      .toBe("Moved from shop to shop-2. The conversation continued from notes.");
  });
});
