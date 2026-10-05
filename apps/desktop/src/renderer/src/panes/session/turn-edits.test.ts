import { describe, expect, it } from "vitest";
import type { Checkpoint, TurnChanges } from "@realm/contracts";
import { editTotals, turnEdits, undoOffer } from "./turn-edits";
import type { Block } from "./transcript-model";

const S = "s1";
const user = (text: string, ts: number): Block => ({ kind: "user", text, ts });
const run = (ts: number): Block => ({ kind: "run", ms: 1_000, startedAt: ts - 1_000, ts });
const edit = (id: string, file: string, before: string, after: string, ts: number, isError = false): Block =>
  ({ kind: "tool", toolUseId: id, name: "Edit", input: { file_path: file, old_string: before, new_string: after }, result: { content: "ok", isError }, ts });
const write = (id: string, file: string, content: string, result: string, ts: number): Block =>
  ({ kind: "tool", toolUseId: id, name: "Write", input: { file_path: file, content }, result: { content: result, isError: false }, ts });
const read = (id: string, file: string, ts: number): Block =>
  ({ kind: "tool", toolUseId: id, name: "Read", input: { file_path: file }, result: { content: "x", isError: false }, ts });
const cp = (id: string, createdAt: number, extra: Partial<Checkpoint> = {}): Checkpoint => ({
  id, environmentId: "e1", sessionId: S, kind: "turn", label: id, ref: `refs/realm/checkpoints/e1/${id}`, commitSha: "c", headSha: null, headRef: null,
  sessionSeq: null, providerCursor: null, createdAt, ...extra,
});
const measuredAt = (settledAt: number, checkpointId: string, files: TurnChanges["files"]): TurnChanges =>
  ({ checkpointId, settledAt, root: "/w/app", afterTree: "a".repeat(40), files, totalFiles: files.length });
const opts = (extra: Partial<Parameters<typeof turnEdits>[1]> = {}) =>
  ({ changes: undefined, checkpoints: [], sessionId: S, cwd: "/w/app", root: "/w/app", ...extra });

describe("what a turn changed", () => {
  it("takes git's account of a measured turn — paths from the checkout's root, the asking message kept", () => {
    const blocks = [user("Fix the org access crash", 100), edit("e1", "/w/app/web/lib/orgs.ts", "a", "b", 150), run(200)];
    const { cards } = turnEdits(blocks, opts({ changes: { 200: measuredAt(200, "cp1", [
      { path: "web/lib/orgs.ts", oldPath: null, status: "modified", additions: 17, deletions: 2 },
      { path: "web/lib/agent/auto-compact.ts", oldPath: null, status: "modified", additions: 3, deletions: 1 },
    ]) } }));
    const card = cards.get("run:2")!;
    expect(card).toMatchObject({ source: "git", checkpointId: "cp1", totalFiles: 2, asked: "Fix the org access crash" });
    expect(card.files.map((f) => [f.path, f.shown, f.additions, f.deletions])).toEqual([
      ["/w/app/web/lib/orgs.ts", "web/lib/orgs.ts", 17, 2], ["/w/app/web/lib/agent/auto-compact.ts", "web/lib/agent/auto-compact.ts", 3, 1]]);
    expect(editTotals(card.files)).toEqual({ additions: 20, deletions: 3 });
  });

  it("draws no card for a turn git measured as changing nothing, whatever its calls claimed", () => {
    // Edited, then put back: the calls say +1 −1, the checkout says nothing moved, and the checkout wins.
    const blocks = [user("try it", 100), edit("e1", "/w/app/a.ts", "x", "y", 110), edit("e2", "/w/app/a.ts", "y", "x", 120), run(200)];
    expect(turnEdits(blocks, opts({ changes: { 200: measuredAt(200, "cp1", []) } })).cards.size).toBe(0);
  });

  it("falls back to the edit calls where nothing measured the turn — counting only what they state", () => {
    const blocks = [user("make notes", 100),
      edit("e1", "/w/app/src/a.ts", "one", "two\nthree", 110),
      edit("e2", "src/a.ts", "three", "four", 115),           // the same file, written relatively
      write("w1", "/w/app/notes/new.md", "# New\n\nhi\n", "File created successfully at: /w/app/notes/new.md", 120),
      write("w2", "/w/app/README.md", "rewritten\n", "The file /w/app/README.md has been updated.", 130),
      edit("e3", "/w/app/src/broken.ts", "nope", "x", 140, true), // failed: changed nothing
      read("r1", "/w/app/src/c.ts", 150), run(200)];
    const card = turnEdits(blocks, opts()).cards.get("run:7")!;
    expect(card.source).toBe("tools");
    expect(card.files.map((f) => [f.shown, f.status, f.additions, f.deletions])).toEqual([
      ["src/a.ts", "modified", 3, 2], ["notes/new.md", "added", 3, 0], ["README.md", "modified", null, null]]);
    // One file's count is unknown, so the head states no total rather than an understated one.
    expect(editTotals(card.files)).toBeNull();
  });

  it("counts an ACP agent's edits off the diffs its results carry, a new file as added", () => {
    const acp = (id: string, path: string, diff: string, ts: number): Block =>
      ({ kind: "tool", toolUseId: id, name: `Editing ${path}`, input: {}, toolKind: "edit", paths: [path], result: { content: diff, isError: false }, ts });
    const blocks = [user("edit", 100),
      acp("a1", "/w/app/x.ts", "--- /w/app/x.ts\n+++ /w/app/x.ts\n@@ -2,1 +2,2 @@\n-b\n+B\n+c", 110),
      acp("a2", "/w/app/new.ts", "--- /dev/null\n+++ /w/app/new.ts\n@@ -0,0 +1,1 @@\n+hi", 120), run(200)];
    const card = turnEdits(blocks, opts()).cards.get("run:3")!;
    expect(card.files.map((f) => [f.shown, f.status, f.additions, f.deletions])).toEqual([["x.ts", "modified", 2, 1], ["new.ts", "added", 1, 0]]);
  });

  it("waits for the measurement of the newest turn a checkpoint fronted, instead of flashing the calls' numbers", () => {
    const blocks = [user("edit", 100), edit("e1", "/w/app/a.ts", "x", "y", 110), run(200)];
    const checkpoints = [cp("cp1", 90)];
    expect(turnEdits(blocks, opts({ checkpoints })).cards.size).toBe(0);
    // A later message means the measurement is never coming (a session from before Realm measured
    // turns) — and then the calls are what there is to say.
    expect(turnEdits([...blocks, user("next", 300)], opts({ checkpoints })).cards.get("run:2")).toMatchObject({ source: "tools", checkpointId: "cp1" });
  });

  it("finds each turn's checkpoint by the clock: after the turn before settled, no later than its message", () => {
    const blocks = [user("one", 100), edit("e1", "/w/app/a.ts", "x", "y", 110), run(200),
      user("two", 300), edit("e2", "/w/app/b.ts", "x", "y", 310), run(400), user("three", 500)];
    const checkpoints = [cp("cp2", 250), cp("cp1", 90), cp("other", 260, { sessionId: "s2" })];
    const { cards, turns } = turnEdits(blocks, opts({ checkpoints }));
    expect(cards.get("run:2")!.checkpointId).toBe("cp1");
    expect(cards.get("run:5")!.checkpointId).toBe("cp2");
    expect(turns.map((t) => t.checkpointId)).toEqual(["cp1", "cp2"]);
  });
});

describe("whether Undo is honest", () => {
  const blocks = [user("one", 100), edit("e1", "/w/app/a.ts", "x", "y", 110), run(200)];
  const card = (checkpoints: Checkpoint[], more: Block[] = []) => {
    const all = [...blocks, ...more];
    const { cards, turns } = turnEdits(all, opts({ checkpoints, changes: { 200: measuredAt(200, "cp1", [{ path: "a.ts", oldPath: null, status: "modified", additions: 1, deletions: 1 }]) } }));
    return { edits: cards.get("run:2")!, turns };
  };

  it("offers Undo on the newest turn — restoring its checkpoint takes back that turn and nothing else", () => {
    const { edits, turns } = card([cp("cp1", 90)]);
    expect(undoOffer(edits, turns, [cp("cp1", 90)], S)).toEqual({ kind: "undo", checkpointId: "cp1" });
  });

  it("keeps offering it past later turns that provably changed nothing", () => {
    const checkpoints = [cp("cp3", 450), cp("cp2", 250), cp("cp1", 90)];
    // A turn that only talked, and one git measured as changing nothing.
    const later: Block[] = [user("why?", 300), { kind: "assistant", messageId: "m", text: "because", streaming: false, ts: 310 }, run(400),
      user("check", 500), read("r", "/w/app/a.ts", 510), run(600)];
    const all = [...blocks, ...later];
    const { cards, turns } = turnEdits(all, opts({ checkpoints, changes: {
      200: measuredAt(200, "cp1", [{ path: "a.ts", oldPath: null, status: "modified", additions: 1, deletions: 1 }]),
      600: measuredAt(600, "cp3", []),
    } }));
    expect(undoOffer(cards.get("run:2")!, turns, checkpoints, S)).toEqual({ kind: "undo", checkpointId: "cp1" });
  });

  it("withdraws it once later work would go with it — an edit since, another session, a restore", () => {
    const edited: Block[] = [user("two", 300), edit("e2", "/w/app/b.ts", "x", "y", 310), run(400)];
    const later = [cp("cp2", 250), cp("cp1", 90)];
    const a = card(later, edited);
    expect(undoOffer(a.edits, a.turns, later, S)).toEqual({ kind: "later" });
    for (const intruder of [cp("x", 250, { sessionId: "s2" }), cp("x", 250, { kind: "pre-restore" }), cp("x", 250, { kind: "manual", sessionId: null })]) {
      const { edits, turns } = card([intruder, cp("cp1", 90)]);
      expect(undoOffer(edits, turns, [intruder, cp("cp1", 90)], S)).toEqual({ kind: "later" });
    }
  });

  it("says so when no checkpoint covers the turn, or when it has been pruned", () => {
    const { cards, turns } = turnEdits(blocks, opts());
    expect(undoOffer(cards.get("run:2")!, turns, [], S)).toMatchObject({ kind: "none", why: expect.stringMatching(/no checkpoint/) });
    const { edits } = card([cp("cp1", 90)]);
    expect(undoOffer(edits, turns, [cp("newer", 300, { kind: "manual", sessionId: null })], S)).toMatchObject({ kind: "none", why: expect.stringMatching(/no longer kept/) });
  });
});
