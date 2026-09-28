import { describe, expect, it } from "vitest";
import type { Session, SessionStatus } from "@realm/contracts";
import { railAgents, workingKey } from "./rail-agents";

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id, spaceId: "s1", projectId: null, agentKind: "claude", environmentId: "env1", cwd: "/w",
  status: "idle", providerSessionId: null, title: id, lastEventSeq: 0, seenSeq: 0,
  model: null, effort: null, permissionMode: null, createdAt: 0, updatedAt: 0,
  ...over,
} as Session);

const rowsOf = (...ss: Session[]) => Object.fromEntries(ss.map((s) => [s.id, s]));
const names = (g: ReturnType<typeof railAgents>) => g.map((x) => [x.state.status, x.rows.map((r) => r.id)]);

describe("the agents the rail lists", () => {
  it("lists only the ones at work, in the Agents page's own order", () => {
    const rows = rowsOf(
      session("a", { spaceId: "s1" }), session("b", { spaceId: "s2" }),
      session("c", { spaceId: "s3" }), session("d"), session("e"),
    );
    const status: Record<string, SessionStatus> = { a: "running", b: "waiting_permission", c: "error", d: "idle", e: "ended" };
    // Needs you first, then Working, then Failed — idle and ended are not at work.
    expect(names(railAgents({ rows, local: {}, status, quickChatId: null })))
      .toEqual([["waiting_permission", ["b"]], ["running", ["a"]], ["error", ["c"]]]);
  });

  it("reads the LIVE status, not the row's", () => {
    /* THE MUTANT: filter on `s.status`. The row says what the server had at the last list; an agent
       that started since is idle there and running live, and the rail would miss it until the next
       refetch — which, for an always-on surface, is exactly the moment it was built for. */
    const rows = rowsOf(session("a", { status: "idle" }), session("b", { status: "running" }));
    expect(names(railAgents({ rows, local: {}, status: { a: "running", b: "idle" }, quickChatId: null })))
      .toEqual([["running", ["a"]]]);
  });

  it("covers every space, and lets the active space's fresher row win", () => {
    const rows = rowsOf(session("a", { spaceId: "s2", title: "old title" }));
    const local = rowsOf(session("a", { spaceId: "s2", title: "new title" }));
    const groups = railAgents({ rows, local, status: { a: "running" }, quickChatId: null });
    expect(groups[0]!.rows[0]!.title).toBe("new title");
    // A session only the cross-space list knows about is still listed — that is the point of a rail.
    expect(names(railAgents({ rows: rowsOf(session("z", { spaceId: "s9" })), local: {}, status: { z: "running" }, quickChatId: null })))
      .toEqual([["running", ["z"]]]);
  });

  it("leaves out the quick chat, which is already its own window and has nothing to reveal", () => {
    const rows = rowsOf(session("qc"), session("a"));
    expect(names(railAgents({ rows, local: {}, status: { qc: "running", a: "running" }, quickChatId: "qc" })))
      .toEqual([["running", ["a"]]]);
  });

  it("is empty when nothing is at work, rather than listing history", () => {
    const rows = rowsOf(session("a"), session("b"));
    expect(railAgents({ rows, local: {}, status: { a: "idle", b: "ended" }, quickChatId: null })).toEqual([]);
  });
});

describe("when the rail re-reads its rows", () => {
  it("changes when an agent starts or stops, and not when one flickers within the set", () => {
    const rows = rowsOf(session("a"), session("b"), session("c"));
    const key = (status: Record<string, SessionStatus>) => workingKey(railAgents({ rows, local: {}, status, quickChatId: null }));
    const base = key({ a: "running", b: "waiting_permission" });
    // b answered its permission and went back to running: same agents at work, same key.
    expect(key({ a: "running", b: "running" })).toBe(base);
    // c started: a new agent is at work, and its title may not be known yet.
    expect(key({ a: "running", b: "running", c: "running" })).not.toBe(base);
    // a finished.
    expect(key({ b: "running" })).not.toBe(base);
  });
});
