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
const tool = (name: string, input: Record<string, unknown> = {}, result: { content: string; isError: boolean } | null = null): Block =>
  ({ kind: "tool", toolUseId: `t-${name}`, name, input, result, ts: 2 });

const hint = (o: Partial<Parameters<typeof promptHint>[0]> = {}) =>
  promptHint({ blocks: [], gitInfo: null, status: "idle", inPlan: false, ...o });

describe("the session's suggested prompt", () => {
  it("says nothing while the turn is still in flight", () => {
    // Both busy statuses: what a follow-up would be about is still being written.
    const blocks = [user("go"), tool("Edit")];
    expect(hint({ blocks, status: "running" })).toBeNull();
    expect(hint({ blocks, status: "waiting_permission" })).toBeNull();
    // …and comes straight back when it settles.
    expect(hint({ blocks, status: "idle" }))
      .toBe("Stress-test the changes, then fix what the tests expose.");
  });

  describe("a session that has not started", () => {
    it("offers the working tree when there is one to review, naming the branch", () => {
      expect(hint({ gitInfo: git({ dirty: 3, branch: "feature/pane-groups" }) }))
        .toBe("Take a skeptical pass over the pane groups work: find the edge case this diff is most likely to miss.");
      expect(hint({ gitInfo: git({ dirty: 1, branch: "main" }) }))
        .toBe("Audit the 1 uncommitted file on main; find the edge case most likely to escape review.");
    });

    it("offers the branch's own commits once the tree is clean, and counts them honestly", () => {
      expect(hint({ gitInfo: git({ ahead: 4, branch: "fix/oauth" }) }))
        .toBe("Write a PR description for the 4 commits on fix/oauth.");
      expect(hint({ gitInfo: git({ ahead: 1 }) })).toBe("Write a PR description for the 1 commit on main.");
      // Uncommitted work outranks committed work — it is the part still being decided.
      expect(hint({ gitInfo: git({ ahead: 4, dirty: 2 }) }))
        .toBe("Audit the 2 uncommitted files on main; find the edge case most likely to escape review.");
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
      expect(hint({ blocks: [...blocks], gitInfo: git({ dirty: 9 }) }))
        .toBe("Investigate “spawn ENOENT”, fix the root cause, and retry.");
      expect(hint({ blocks: [user("go"), tool("Write"), { kind: "error", message: "x", ts: 3 } as Block] }))
        .toBe("Investigate “x”, fix the root cause, and retry.");
    });

    it("names the command when a tool failed, instead of quoting a wall of output", () => {
      const failed = tool("Bash", { command: "pnpm vitest run prompt-hint.test.ts" }, { content: "500 lines of output", isError: true });
      expect(hint({ blocks: [user("Improve the suggested prompts"), failed] }))
        .toBe("Investigate “pnpm vitest run prompt-hint.test.ts” while working on suggested prompts, fix the root cause, and retry.");
    });

    it("says go when a plan is on screen and the agent cannot act on it", () => {
      const blocks = [user("plan it"), assistant("Here is the plan.")];
      expect(hint({ blocks, inPlan: true }))
        .toBe("Implement the plan, then verify its riskiest assumption.");
      // Out of Plan, it still continues the actual subject rather than falling back to repo state.
      expect(hint({ blocks, inPlan: false })).toBeNull();
    });

    it("suggests the tests once the agent has written to a file", () => {
      for (const name of ["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]) {
        expect(hint({ blocks: [user("Improve the prompt hints"), tool(name)] }))
          .toBe("Stress-test prompt hints, then fix what the tests expose.");
      }
    });

    it("names the files the last turn actually changed", () => {
      const blocks = [
        user("Could you refactor the composer state?"),
        tool("Edit", { file_path: "/repo/apps/Composer.tsx" }),
        tool("Write", { file_path: "/repo/apps/composer.test.tsx" }),
      ];
      expect(hint({ blocks })).toBe(
        "Stress-test composer state in apps/Composer.tsx and apps/composer.test.tsx, then fix what the tests expose.",
      );
    });

    it("extracts changed files from apply_patch input", () => {
      const patch = "*** Begin Patch\n*** Update File: src/hints.ts\n*** Add File: src/hints.test.ts\n*** End Patch";
      expect(hint({ blocks: [user("Improve hint specificity"), tool("apply_patch", { patch })] }))
        .toBe("Stress-test hint specificity in src/hints.ts and src/hints.test.ts, then fix what the tests expose.");
    });

    it("does not mistake reading and running for writing", () => {
      // The distinction the WRITE_TOOLS set exists for: a turn that only looked around has not
      // produced anything to test.
      expect(hint({ blocks: [user("go"), tool("Read"), tool("Grep"), tool("Bash")] })).toBeNull();
      expect(hint({ blocks: [user("Explain session restore"), tool("Read", { file_path: "/repo/state/store.ts" }), assistant("It works like this.")] }))
        .toBe("Trace session restore through state/store.ts, then identify the highest-leverage change.");
    });

    it("only looks at the LAST turn — an edit two turns ago is not what just happened", () => {
      const blocks = [user("edit it"), tool("Edit"), assistant("done"), user("now explain"), assistant("because…")];
      expect(hint({ blocks }))
        .toBe("Take “now explain” further: show the concrete code path and its weakest edge case.");
      // …and the dirty tree cannot displace the continuation of the current conversation.
      expect(hint({ blocks, gitInfo: git({ dirty: 1 }) }))
        .toBe("Take “now explain” further: show the concrete code path and its weakest edge case.");
    });

    it("turns a plain conversation into a follow-up anchored to what the user asked", () => {
      expect(hint({ blocks: [user("What is this repo?"), assistant("A desktop app.")], gitInfo: git() }))
        .toBe("Take “what is this repo” further: show the concrete code path and its weakest edge case.");
    });
  });
});
