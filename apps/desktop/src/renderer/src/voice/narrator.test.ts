import { describe, expect, it } from "vitest";
import { emptyTranscript, type Block, type PendingPermission, type Transcript } from "../panes/session/transcript-model";
import { Narrator, TOOL_STATUS_GAP_MS, permissionPrompt, toolStatus } from "./narrator";

const t = (blocks: Block[], pendingPermissions: PendingPermission[] = []): Transcript => ({ ...emptyTranscript(), blocks, pendingPermissions });
const reply = (text: string, streaming = true, messageId = "m1"): Block => ({ kind: "assistant", messageId, text, streaming, ts: 0 });
const tool = (id: string, name: string, input: Record<string, unknown> = {}, extra: Partial<Extract<Block, { kind: "tool" }>> = {}): Block =>
  ({ kind: "tool", toolUseId: id, name, input, result: null, ts: 0, ...extra });

describe("Narrator", () => {
  it("reads nothing that was there before voice mode opened", () => {
    const before = t([{ kind: "user", text: "hi", ts: 0 }, reply("An old answer.", false)]);
    const n = new Narrator(before.blocks.length, "Claude");
    // THE MUTANT: start from the top — opening voice mode on a long session reads the whole log.
    expect(n.next(before, 0, true)).toEqual([]);
    expect(n.next(t([...before.blocks, { kind: "user", text: "and?", ts: 1 }, reply("New answer.", false, "m2")]), 0, true)).toEqual(["New answer."]);
  });

  it("follows a reply as it streams and finishes it when it settles", () => {
    const n = new Narrator(0, "Claude");
    expect(n.next(t([reply("First. Sec")]), 0, true)).toEqual(["First."]);
    expect(n.next(t([reply("First. Second")]), 0, true)).toEqual([]);
    expect(n.next(t([reply("First. Second", false)]), 0, true)).toEqual(["Second"]);
  });

  it("says a tool's status in passing — not behind speech, not ten in a row, not a sub-agent's", () => {
    const n = new Narrator(0, "Claude");
    const blocks = [tool("a", "Bash", { command: "pnpm test", description: "Run the tests" })];
    expect(n.next(t(blocks), 0, true)).toEqual(["Run the tests."]);
    // Inside the gap: the next call is quiet.
    blocks.push(tool("b", "Read", { file_path: "/x/src/app.ts" }));
    // THE MUTANT: no gap — an agent reading ten files says "reading" ten times.
    expect(n.next(t(blocks), 1000, true)).toEqual([]);
    blocks.push(tool("c", "Read", { file_path: "/x/src/b.ts" }, { parentToolUseId: "a" }));
    expect(n.next(t(blocks), TOOL_STATUS_GAP_MS + 1000, true)).toEqual([]);
    blocks.push(tool("d", "Edit", { file_path: "/x/src/c.ts" }));
    // Not while something is being said.
    expect(n.next(t(blocks), TOOL_STATUS_GAP_MS * 2, false)).toEqual([]);
    blocks.push(tool("e", "Edit", { file_path: "/x/src/d.ts" }));
    expect(n.next(t(blocks), TOOL_STATUS_GAP_MS * 3, true)).toEqual(["Editing d.ts."]);
  });

  it("reads each permission once, and how to answer it", () => {
    const n = new Narrator(0, "Mina");
    const p: PendingPermission = { requestId: "r1", toolName: "Bash", input: { command: "rm -rf dist" }, title: "Run `rm -rf dist`" };
    expect(n.next(t([], [p]), 0, true)).toEqual(["Mina asks to run rm -rf dist. Say yes or no."]);
    // THE MUTANT: forget which were read — the same question every time the transcript changes.
    expect(n.next(t([], [p]), 0, true)).toEqual([]);
  });

  it("says a failure in a sentence", () => {
    const n = new Narrator(0, "Claude");
    expect(n.next(t([{ kind: "error", message: "Rate limited. Try again in a minute.", ts: 0 }]), 0, true)).toEqual(["That failed: Rate limited."]);
    expect(n.next(t([{ kind: "error", message: "Rate limited. Try again in a minute.", ts: 0 }]), 0, true)).toEqual([]);
  });

  it("stops reading the reply it was on once told to skip past it", () => {
    const n = new Narrator(0, "Claude");
    expect(n.next(t([reply("One. Two")]), 0, true)).toEqual(["One."]);
    n.skipTo(1);
    // THE MUTANT: a barge-in hushes the speech but the narrator keeps feeding the old reply.
    expect(n.next(t([reply("One. Two. Three.", false)]), 0, true)).toEqual([]);
  });
});

describe("toolStatus and permissionPrompt", () => {
  it("names the file, not its path, and says nothing for planning", () => {
    expect(toolStatus("Read", { file_path: "/a/b/notes.md" })).toBe("Reading notes.md.");
    expect(toolStatus("TodoWrite", {})).toBeNull();
    expect(toolStatus("mcp__linear__get_issue", { id: "LIN-12" })).toBe("Working on LIN-12.");
  });

  it("sends a question to the chat rather than reading its options", () => {
    expect(permissionPrompt({ requestId: "q", toolName: "AskUserQuestion", input: {}, title: "Which branch?", ask: { questions: [] } as never }, "Claude"))
      .toBe("Claude has a question for you in the chat.");
  });
});
