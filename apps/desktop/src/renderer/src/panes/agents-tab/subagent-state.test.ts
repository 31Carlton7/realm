import { describe, expect, it } from "vitest";
import { sessionEvent, type DelegatedChild } from "@realm/contracts";
import { session } from "../../state/store.test-fakes";
import { modelLabel, reportSummary, subagentElapsed, subagentState, taskTitle } from "./subagent-state";

function child(over: Partial<DelegatedChild> = {}, status: "idle" | "running" | "waiting_permission" | "error" | "ended" = "idle"): DelegatedChild {
  return {
    session: session("se2", "s1", { agentKind: "codex", model: "gpt-6-luna", status, dispatchedBy: { sessionId: "se1", kind: "agent_run" } }),
    goal: "Write the tests\n\nThe toggle lives in Settings ▸ App.", startedAt: 1_000, settledAt: null, outcome: null, report: null, activity: null,
    ...over,
  };
}

describe("subagentState", () => {
  it("a live status wins over the recorded outcome — a finished child sent another message is working again", () => {
    expect(subagentState(child({ outcome: "done" }), "running", false)).toBe("working");
    expect(subagentState(child(), "waiting_permission", true)).toBe("waiting");
  });

  it("once it is not busy, the outcome says how the run ended — which the status cannot", () => {
    // Mutant: read state off the status alone. A timeout and a finish both sit at idle.
    expect(subagentState(child({ outcome: "timeout" }), "idle", false)).toBe("timeout");
    expect(subagentState(child({ outcome: "done" }), "idle", false)).toBe("done");
    expect(subagentState(child({ outcome: "stopped" }), "idle", false)).toBe("stopped");
    expect(subagentState(child({ outcome: "interrupted" }), "idle", false)).toBe("cancelled");
    expect(subagentState(child({ outcome: "failed" }), "idle", false)).toBe("failed");
  });

  it("with nothing recorded: queued while its run is in flight, then judged by whether it spoke", () => {
    expect(subagentState(child(), "idle", true)).toBe("queued");
    // A browser agent or a reviewer keeps no ledger; its last word is the evidence it finished.
    expect(subagentState(child({ report: "Done." }), "idle", false)).toBe("done");
    expect(subagentState(child(), "idle", false)).toBe("stopped");
    expect(subagentState(child({}, "ended"), undefined, false)).toBe("failed");
    expect(subagentState(child({}, "error"), undefined, false)).toBe("failed");
  });

  it("reads the row's status when no live one has arrived", () => {
    expect(subagentState(child({}, "running"), undefined, true)).toBe("working");
  });
});

describe("subagentElapsed", () => {
  it("ticks from the start while live, and is the run's own span once settled", () => {
    expect(subagentElapsed(child(), "working", 61_000)).toBe(60_000);
    expect(subagentElapsed(child({ settledAt: 31_000, outcome: "done" }), "done", 999_999)).toBe(30_000);
  });

  it("falls back to its last activity when the run was never timed", () => {
    const c = child({ activity: { ...sessionEvent("assistant_text", { messageId: "m", text: "ok" }), ts: 11_000 } });
    expect(subagentElapsed(c, "done", 999_999)).toBe(10_000);
  });
});

describe("modelLabel", () => {
  const probe = [{ kind: "codex" as const, models: [{ id: "gpt-6-luna", label: "GPT-6 Luna" }] },
    { kind: "acp:cursor" as const, models: [{ id: "gpt-5.3-codex[reasoning=medium]", label: "gpt-5.3-codex[reasoning=medium]" }] }];
  it("names a model from the probe's catalog, then the curated list, then gives up to the id", () => {
    expect(modelLabel("codex", "gpt-6-luna", probe)).toBe("GPT-6 Luna");
    expect(modelLabel("claude", "claude-opus-5-5", probe)).toBe("Claude Opus 5.5");
    expect(modelLabel("codex", "gpt-9", probe)).toBe("gpt-9");
  });
  it("says what the harness runs when nothing is pinned, and drops an ACP setting suffix", () => {
    expect(modelLabel("claude", null, probe)).toBe("Fable 5.1");
    expect(modelLabel("acp:cursor", "gpt-5.3-codex[reasoning=medium]", probe)).toBe("gpt-5.3-codex");
  });
});

describe("the row's words", () => {
  it("titles a task by its first line", () => {
    expect(taskTitle("\n  Write the tests\nmore", "x")).toBe("Write the tests");
    expect(taskTitle(null, "Agent: go")).toBe("Agent: go");
  });

  it("reads a markdown report as plain prose", () => {
    expect(reportSummary("## Done\n\n- Added **the toggle** in `App.tsx`\n- See [the PR](https://x.y)\n\n```ts\nconst a = 1;\n```\nAll 12 pass."))
      .toBe("Done Added the toggle in App.tsx See the PR All 12 pass.");
  });
});
