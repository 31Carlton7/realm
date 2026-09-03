import { describe, expect, it } from "vitest";
import type { GitInfo } from "@realm/contracts";
import { promptHint } from "./prompt-hint";
import { SUGGESTIONS } from "./suggestions";
import type { Block } from "./transcript-model";

/**
 * The prompter's hint text is a claim about THIS session — the sentence ⇥ will type for the user.
 * Every rung of the ladder is here, and so is the thing that matters more: the states where the
 * honest answer is no suggestion at all. A hint that appeared mid-turn, or that said "run the tests"
 * because the agent read a file, would be worse than the plain placeholder it replaces.
 */
const git = (extra: Partial<GitInfo> = {}): GitInfo =>
  ({ branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0, ...extra });

const user = (text: string): Block => ({ kind: "user", text, ts: 1 });
const assistant = (text: string): Block => ({ kind: "assistant", messageId: "m1", text, streaming: false, ts: 2 });
const tool = (name: string): Block => ({ kind: "tool", toolUseId: `t-${name}`, name, input: {}, result: null, ts: 2 });

const hint = (o: Partial<Parameters<typeof promptHint>[0]> = {}) =>
  promptHint({ blocks: [], gitInfo: null, status: "idle", inPlan: false, ...o });

describe("the session's suggested prompt", () => {
  it("says nothing while the turn is still in flight", () => {
    // Both busy statuses: what a follow-up would be about is still being written.
    const blocks = [user("go"), tool("Edit")];
    expect(hint({ blocks, status: "running" })).toBeNull();
    expect(hint({ blocks, status: "waiting_permission" })).toBeNull();
    // …and comes straight back when it settles.
    expect(hint({ blocks, status: "idle" })).toBe("Run the tests and fix anything that fails.");
  });

  describe("a session that has not started", () => {
    it("offers the working tree when there is one to review, naming the branch", () => {
      expect(hint({ gitInfo: git({ dirty: 3, branch: "feature/pane-groups" }) }))
        .toBe("Review my uncommitted changes on feature/pane-groups for bugs and style issues.");
    });

    it("offers the branch's own commits once the tree is clean, and counts them honestly", () => {
      expect(hint({ gitInfo: git({ ahead: 4, branch: "fix/oauth" }) }))
        .toBe("Write a PR description for the 4 commits on fix/oauth.");
      expect(hint({ gitInfo: git({ ahead: 1 }) })).toBe("Write a PR description for the 1 commit on main.");
      // Uncommitted work outranks committed work — it is the part still being decided.
      expect(hint({ gitInfo: git({ ahead: 4, dirty: 2 }) }))
        .toBe("Review my uncommitted changes on main for bugs and style issues.");
    });

    it("says nothing at all when there is no session-specific fact to offer", () => {
      // Not a repo; a clean checkout with nothing ahead. The hero's chips are right there and this
      // must NEVER restate one of them — `suggestions.ts` is deliberately not a fallback here.
      expect(hint({ gitInfo: null })).toBeNull();
      expect(hint({ gitInfo: git({ additions: 90, deletions: 4 }) })).toBeNull();
      for (const s of SUGGESTIONS.claude) expect(hint({ gitInfo: git({ dirty: 3 }) })).not.toBe(s.prompt);
    });
  });

  describe("a session mid-conversation", () => {
    it("leads with the error when the last turn ended in one", () => {
      const blocks = [user("go"), { kind: "error", message: "spawn ENOENT", ts: 3 } as Block];
      // Outranks the dirty tree AND the edits — nothing else matters until the session runs again.
      expect(hint({ blocks: [...blocks], gitInfo: git({ dirty: 9 }) })).toBe("Fix that error and try again.");
      expect(hint({ blocks: [user("go"), tool("Write"), { kind: "error", message: "x", ts: 3 } as Block] }))
        .toBe("Fix that error and try again.");
    });

    it("says go when a plan is on screen and the agent cannot act on it", () => {
      const blocks = [user("plan it"), assistant("Here is the plan.")];
      expect(hint({ blocks, inPlan: true })).toBe("Go ahead and implement that plan.");
      // Out of Plan the same transcript is just a conversation — implementing is not the obvious next move.
      expect(hint({ blocks, inPlan: false })).toBeNull();
    });

    it("suggests the tests once the agent has written to a file", () => {
      for (const name of ["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]) {
        expect(hint({ blocks: [user("go"), tool(name)] })).toBe("Run the tests and fix anything that fails.");
      }
    });

    it("does not mistake reading and running for writing", () => {
      // The distinction the WRITE_TOOLS set exists for: a turn that only looked around has not
      // produced anything to test.
      expect(hint({ blocks: [user("go"), tool("Read"), tool("Grep"), tool("Bash")] })).toBeNull();
    });

    it("only looks at the LAST turn — an edit two turns ago is not what just happened", () => {
      const blocks = [user("edit it"), tool("Edit"), assistant("done"), user("now explain"), assistant("because…")];
      expect(hint({ blocks })).toBeNull();
      // …and the dirty tree that edit left behind is what it falls through to.
      expect(hint({ blocks, gitInfo: git({ dirty: 1 }) }))
        .toBe("Review my uncommitted changes on main for bugs and style issues.");
    });

    it("offers nothing rather than filler for a plain conversation in a clean tree", () => {
      expect(hint({ blocks: [user("what is this repo?"), assistant("A desktop app.")], gitInfo: git() })).toBeNull();
    });
  });
});
