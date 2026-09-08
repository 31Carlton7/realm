import { describe, expect, it } from "vitest";
import type { GitInfo } from "@realm/contracts";
import { promptHint } from "./prompt-hint";
import type { Block } from "./transcript-model";

/**
 * The prompter's hint text is a claim about THIS session — the sentence ⇥ will type for the user.
 *
 * Two things are pinned throughout, and both are about restraint. The hint is SHORT: a handful of
 * words, never the session's own text carried back at it, because the line it replaces is a
 * placeholder someone reads at a glance and accepts with one key. And it declines: the states where
 * the honest answer is no suggestion at all outnumber the ones where there is something to say.
 */
const git = (extra: Partial<GitInfo> = {}): GitInfo =>
  ({ branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0, ...extra });

const user = (text: string): Block => ({ kind: "user", text, ts: 1 });
const assistant = (text: string): Block => ({ kind: "assistant", messageId: "m1", text, streaming: false, ts: 2 });
const tool = (name: string, input: Record<string, unknown> = {}, result: { content: string; isError: boolean } | null = null): Block =>
  ({ kind: "tool", toolUseId: `t-${name}`, name, input, result, ts: 2 });
const plan = (): Block => ({ kind: "plan", planId: "p1", text: "# The plan", ts: 2 });

const hint = (o: Partial<Parameters<typeof promptHint>[0]> = {}) =>
  promptHint({ blocks: [], gitInfo: null, status: "idle", inPlan: false, ...o });

describe("the session's suggested prompt", () => {
  it("is short enough to read at a glance, in every state that produces one", () => {
    /* The regression this exists to prevent, verbatim from a real session:
         Fix “EISDIR: illegal operation on a directory, read…” while working on give me a to…
       Nobody reads that at a glance and nobody accepts it with one key. Eight words is the ceiling;
       the context belongs to the session, and the hint only has to name the next move. */
    const cases: (string | null)[] = [
      hint({ gitInfo: git({ dirty: 3, branch: "feature/pane-groups" }) }),
      hint({ gitInfo: git({ ahead: 4 }) }),
      hint({ blocks: [user("go"), tool("Edit", { file_path: "/repo/a/b.ts" })] }),
      hint({ blocks: [user("go"), tool("Edit"), tool("Write")] }),
      hint({ blocks: [user("go"), plan()], inPlan: true }),
      hint({ blocks: [user("go"), assistant("done")] }),
      hint({ blocks: [user("go"), assistant("boom")], status: "error" }),
    ];
    for (const c of cases) {
      expect(c, String(c)).not.toBeNull();
      expect(c!.split(/\s+/).length, c!).toBeLessThanOrEqual(8);
      expect(c!.length, c!).toBeLessThanOrEqual(56);
    }
  });

  it("says nothing while the turn is still in flight", () => {
    const blocks = [user("go"), tool("Edit")];
    expect(hint({ blocks, status: "running" })).toBeNull();
    expect(hint({ blocks, status: "waiting_permission" })).toBeNull();
    expect(hint({ blocks, status: "idle" })).toBe("Walk me through what changed.");
  });

  describe("a session that has not started", () => {
    it("offers the working tree when there is one to review", () => {
      // A descriptive branch names the work; `main` names nothing, so the hint stays generic rather
      // than counting files at the reader.
      expect(hint({ gitInfo: git({ dirty: 3, branch: "feature/pane-groups" }) })).toBe("Review my pane groups changes.");
      expect(hint({ gitInfo: git({ dirty: 1, branch: "main" }) })).toBe("Review my changes.");
    });

    it("offers the branch's own commits once the tree is clean", () => {
      expect(hint({ gitInfo: git({ ahead: 4, branch: "fix/oauth" }) })).toBe("Write a PR description.");
      // Uncommitted work outranks committed work — it is the part still being decided.
      expect(hint({ gitInfo: git({ ahead: 4, dirty: 2 }) })).toBe("Review my changes.");
    });

    it("says nothing at all when there is no session-specific fact to offer", () => {
      expect(hint({ gitInfo: null })).toBeNull();
      expect(hint({ gitInfo: git({ additions: 90, deletions: 4 }) })).toBeNull();
    });
  });

  describe("a session mid-conversation", () => {
    it("offers to fix something only when the TURN ended badly", () => {
      /* The bug this fixes. An agent that hits an EISDIR, notices, and goes on to answer the
         question has not failed — it recovered, and the tool error is a step in a successful turn.
         Offering "Fix …" under a finished answer was the app inventing a problem out of a step.
         The session's own status is the only thing that knows the difference. */
      const recovered = [
        user("Give me a tour of this project."),
        tool("Read", { file_path: "/repo/src" }, { content: "EISDIR: illegal operation on a directory, read", isError: true }),
        assistant("Here is the tour."),
      ];
      expect(hint({ blocks: recovered, status: "idle" })).not.toMatch(/^Fix/);
      expect(hint({ blocks: recovered, status: "error" })).toBe("Find what went wrong and fix it.");
    });

    it("never quotes an error's text back into the prompt", () => {
      const blocks = [user("go"), { kind: "error", message: "EISDIR: illegal operation on a directory, read", ts: 3 } as Block];
      expect(hint({ blocks, status: "error" })).toBe("Find what went wrong and fix it.");
      expect(hint({ blocks, status: "error" })).not.toContain("EISDIR");
    });

    it("says go when a plan is on screen and the agent cannot act on it", () => {
      const blocks = [user("plan it"), plan()];
      expect(hint({ blocks, inPlan: true })).toBe("Build the plan.");
    });

    it("waits for a real plan rather than reading one into any finished sentence", () => {
      // The mutant: gating on `assistant && !streaming` again. An agent that asked a clarifying
      // question and stopped would be answered with "Build the plan" — there is no plan.
      expect(hint({ blocks: [user("plan it"), assistant("Which files should I look at first?")], inPlan: true }))
        .not.toBe("Build the plan.");
    });

    it("offers something NEUTRAL when it cannot tell what kind of file was written", () => {
      /* "Write tests for it" is a fine next move for a module and a nonsense one for an essay, and
         this app is used for both — an agent here writes lectures, study guides and essays as often
         as it writes source. With no path to read an extension from, the safe offer is the one that
         is true of either. */
      for (const name of ["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]) {
        expect(hint({ blocks: [user("go"), tool(name)] }), name).toBe("Walk me through what changed.");
      }
    });

    it("names ONE file when the turn touched one, and stays generic past that", () => {
      // Two paths is a list, and a list is longer than the sentence it is in.
      expect(hint({ blocks: [user("go"), tool("Edit", { file_path: "/repo/apps/Composer.tsx" })] }))
        .toBe("Write tests for apps/Composer.tsx.");
      expect(hint({ blocks: [
        user("go"),
        tool("Edit", { file_path: "/repo/apps/Composer.tsx" }),
        tool("Write", { file_path: "/repo/apps/composer.test.tsx" }),
      ] })).toBe("Write tests for the changes.");
    });

    it("does not mistake reading and running for writing", () => {
      // The distinction WRITE_TOOLS exists for: a turn that only looked around has produced nothing
      // to test. It still has a trail worth following.
      expect(hint({ blocks: [user("go"), tool("Read", { file_path: "/repo/state/store.ts" }), assistant("It works like this.")] }))
        .toBe("Walk me through state/store.ts.");
      expect(hint({ blocks: [user("go"), tool("Grep"), tool("Bash"), assistant("Found it.")] }))
        .toBe("Give me an example.");
    });

    it("only looks at the LAST turn — an edit two turns ago is not what just happened", () => {
      const blocks = [user("edit it"), tool("Edit"), assistant("done"), user("now explain"), assistant("because…")];
      expect(hint({ blocks })).toBe("Give me an example.");
      // …and the dirty tree cannot displace the continuation of the current conversation.
      expect(hint({ blocks, gitInfo: git({ dirty: 1 }) })).toBe("Give me an example.");
    });
  });
});

describe("what the agent WROTE decides what to offer next", () => {
  /* Realm is not a coding tool that happens to open documents. An agent here writes lectures, study
     guides and essays as often as it writes source, and "write tests for jordan-goat-essay.md" is
     the shape of suggestion that makes an app feel like it is not listening. The extension knows
     which kind of file it was; the tool name does not. */
  it("offers to tighten prose, not to test it", () => {
    for (const path of ["/w/jordan-goat-essay.md", "/w/notes.txt", "/w/report.docx", "/w/paper.tex"]) {
      expect(hint({ blocks: [user("go"), tool("Write", { file_path: path })] }), path)
        .toMatch(/^Tighten /);
    }
  });

  it("still offers tests for code", () => {
    for (const path of ["/w/parser.ts", "/w/app.py", "/w/main.go", "/w/style.css"]) {
      expect(hint({ blocks: [user("go"), tool("Write", { file_path: path })] }), path)
        .toMatch(/^Write tests for /);
    }
  });

  it("says something true of either when the file is neither", () => {
    // A `.zip` or a `.png` is not prose and not code, and offering to test one would be worse than
    // offering nothing.
    expect(hint({ blocks: [user("go"), tool("Write", { file_path: "/w/bundle.zip" })] }))
      .toBe("Walk me through w/bundle.zip.");
  });

  it("a tool-free answer asks for an example, not for code", () => {
    // "Show me the code behind that" is a sentence about a codebase, asked of a session that may
    // never have had one. An example is the concrete follow-up to an explanation about anything.
    expect(hint({ blocks: [user("who was Stuart Diamond?"), assistant("A Wharton professor…")] }))
      .toBe("Give me an example.");
  });
});
