import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Checkpoint, TurnChanges } from "@realm/contracts";
import { Transcript } from "./Transcript";
import type { Block, Transcript as TranscriptModel } from "./transcript-model";

afterEach(cleanup);

const changes: TurnChanges = {
  checkpointId: "cp1", settledAt: 200, root: "/w/app", afterTree: "a".repeat(40), totalFiles: 3,
  files: [
    { path: "web/lib/orgs.ts", oldPath: null, status: "modified", additions: 17, deletions: 2 },
    { path: "web/lib/agent/chat-runtime/compaction/auto-compact.ts", oldPath: null, status: "modified", additions: 3, deletions: 1 },
    { path: "old/gone.ts", oldPath: null, status: "deleted", additions: 0, deletions: 9 },
  ],
};
const blocks: Block[] = [
  { kind: "user", text: "Fix the org access crash path", ts: 100 },
  { kind: "assistant", messageId: "m1", text: "Fixed.", streaming: false, ts: 190 },
  { kind: "run", ms: 90_000, startedAt: 110, ts: 200 },
];
const model = (extra: Partial<TranscriptModel> = {}): TranscriptModel =>
  ({ blocks, run: null, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, feedback: {}, summary: null, promptHint: null, changes: { 200: changes }, ...extra });
const checkpoint: Checkpoint = { id: "cp1", environmentId: "e1", sessionId: "s1", kind: "turn", label: "Fix", ref: "r", commitSha: "c", headSha: null, headRef: null, sessionSeq: null, providerCursor: null, createdAt: 90 };

function mount(opts: { checkpoints?: Checkpoint[]; transcript?: TranscriptModel } = {}) {
  const onOpen = vi.fn(), onReview = vi.fn(), onUndo = vi.fn();
  render(<Transcript sessionStatus="idle" onDecide={() => {}} cwd="/w/app" transcript={opts.transcript ?? model()}
    checkout={{ root: "/w/app", onOpen }}
    turnEditing={{ sessionId: "s1", checkpoints: opts.checkpoints ?? [checkpoint], onReview, onUndo }} />);
  return { onOpen, onReview, onUndo, card: screen.getByRole("region", { name: "Edited 3 files" }) };
}

describe("the card a turn that changed files ends with", () => {
  it("says what changed in total and per file, the directory apart from the name", () => {
    const { card } = mount();
    expect(within(card).getByText("Edited 3 files")).toBeTruthy();
    const head = card.querySelector(".edit-summary-head .edit-counts")!;
    expect(head.textContent).toBe("+20−12");
    const rows = [...card.querySelectorAll(".edit-file")];
    expect(rows.map((r) => [r.querySelector(".edit-file-dir")?.textContent, r.querySelector(".edit-file-name")!.textContent, r.querySelector(".edit-counts")?.textContent]))
      .toEqual([["web/lib/", "orgs.ts", "+17−2"], ["web/lib/agent/chat-runtime/compaction/", "auto-compact.ts", "+3−1"], ["old/", "gone.ts", "−9"]]);
  });

  it("sits above the run line it belongs to, so the turn still closes on when it ended", () => {
    mount();
    const col = document.querySelector(".transcript-col")!;
    const kids = [...col.children].map((el) => el.className.split(" ")[0]);
    expect(kids.indexOf("edit-summary")).toBe(kids.indexOf("msg-run") - 1);
  });

  it("opens a file from its row, and a deleted one is a row with nothing to open", () => {
    const { card, onOpen } = mount();
    fireEvent.click(within(card).getByRole("button", { name: /orgs\.ts/ }));
    expect(onOpen).toHaveBeenCalledWith("/w/app/web/lib/orgs.ts", null);
    expect(within(card).queryByRole("button", { name: /gone\.ts/ })).toBeNull();
    expect(within(card).getByText("Deleted")).toBeTruthy();
  });

  it("reviews the turn's own measured changes, named by the message that asked for them", () => {
    const { card, onReview } = mount();
    fireEvent.click(within(card).getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalledWith(changes, "Fix the org access crash path");
  });

  it("opens Review on the files in the order the card lists them", () => {
    // The turn edited auto-compact.ts first; git lists orgs.ts first. The card follows the turn, and
    // so does the review it opens.
    const edited: Block[] = [blocks[0]!,
      { kind: "tool", toolUseId: "e1", name: "Edit", ts: 150, result: { content: "ok", isError: false },
        input: { file_path: "/w/app/web/lib/agent/chat-runtime/compaction/auto-compact.ts", old_string: "a", new_string: "b" } },
      blocks[1]!, blocks[2]!];
    const { card, onReview } = mount({ transcript: model({ blocks: edited }) });
    fireEvent.click(within(card).getByRole("button", { name: "Review" }));
    expect(onReview.mock.calls[0]![0].files.map((f: { path: string }) => f.path))
      .toEqual(["web/lib/agent/chat-runtime/compaction/auto-compact.ts", "web/lib/orgs.ts", "old/gone.ts"]);
  });

  it("offers Undo when the turn's checkpoint is the newest, and hands it that checkpoint", () => {
    const { card, onUndo } = mount();
    fireEvent.click(within(card).getByRole("button", { name: /Undo/ }));
    expect(onUndo).toHaveBeenCalledWith("cp1");
  });

  it("offers no Undo once later work would go with it, and says so where no checkpoint covers the turn", () => {
    const later = { ...checkpoint, id: "cp2", sessionId: "s2", createdAt: 300 };
    const { card } = mount({ checkpoints: [later, checkpoint] });
    expect(within(card).queryByRole("button", { name: /Undo/ })).toBeNull();
    cleanup();
    // Measured against a checkpoint retention has since dropped.
    const pruned = mount({ checkpoints: [], transcript: model({ changes: { 200: { ...changes, checkpointId: "pruned" } } }) });
    expect(within(pruned.card).queryByRole("button", { name: /Undo/ })).toBeNull();
    expect(within(pruned.card).getByText("No checkpoint").getAttribute("title")).toMatch(/no longer kept/);
    cleanup();
    // A plain folder: no checkpoint, no measurement — the agent's own edit is all there is.
    const edited: Block[] = [blocks[0]!, { kind: "tool", toolUseId: "e1", name: "Edit", input: { file_path: "/w/app/a.ts", old_string: "x", new_string: "y" },
      result: { content: "ok", isError: false }, ts: 150 }, blocks[2]!];
    render(<Transcript sessionStatus="idle" onDecide={() => {}} cwd="/w/app" transcript={model({ blocks: edited, changes: undefined })}
      checkout={{ root: "/w/app", onOpen: () => {} }} turnEditing={{ sessionId: "s1", checkpoints: [], onReview: () => {}, onUndo: () => {} }} />);
    const plain = screen.getByRole("region", { name: "Edited 1 file" });
    expect(within(plain).getByText("No checkpoint").getAttribute("title")).toMatch(/cannot put these files back/);
    // And no Review: nothing measured an "after" to diff the turn against.
    expect(within(plain).queryByRole("button", { name: "Review" })).toBeNull();
  });

  it("is not drawn for a turn only its tool calls describe when they changed nothing, nor in a read-only mount", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} cwd="/w/app" transcript={model()} />);
    expect(document.querySelector(".edit-summary")).toBeNull();
  });
});
