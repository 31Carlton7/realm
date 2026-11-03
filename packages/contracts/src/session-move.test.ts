import { describe, expect, it } from "vitest";
import { PERSISTED_EVENT_TYPES, SessionEventSchema } from "./session-events";
import { SessionStatusSchema } from "./entities";
import { MoveTargetSchema } from "./session-move";
import { Methods } from "./rpc";

const place = { machine: null, environmentId: "01J00000000000000000000000", cwd: "/repo", branch: "main" };

describe("session move contracts", () => {
  it("keeps how a move ended and drops its progress", () => {
    expect(PERSISTED_EVENT_TYPES).toContain("moved");
    expect(PERSISTED_EVENT_TYPES).toContain("move_failed");
    expect(PERSISTED_EVENT_TYPES).not.toContain("moving");
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
});
