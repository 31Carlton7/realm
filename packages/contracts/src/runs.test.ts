import { describe, expect, it } from "vitest";
import { isRunLive, isRunTerminal, parseBlockRequest, RUN_BLOCK_SENTINEL, RUN_LIVE_STATES, RUN_STATES, RunConstraintsSchema } from "./runs";

describe("run states", () => {
  it("partitions every state into live or terminal, with nothing in both or neither", () => {
    for (const state of RUN_STATES) expect(isRunLive(state)).toBe(!isRunTerminal(state));
    expect(RUN_STATES.filter(isRunLive)).toEqual([...RUN_LIVE_STATES]);
  });
});

describe("parseBlockRequest", () => {
  it("reads the reason off a sentinel line", () => {
    expect(parseBlockRequest(`${RUN_BLOCK_SENTINEL} which citation style?`)).toBe("which citation style?");
  });

  it("finds the sentinel on any line, not only the first", () => {
    expect(parseBlockRequest(`I got the readings.\n\n${RUN_BLOCK_SENTINEL} the portal wants a 2FA code.`))
      .toBe("the portal wants a 2FA code.");
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(parseBlockRequest("   needs-human:  a decision only you can make  ")).toBe("a decision only you can make");
  });

  /**
   * THE mutant this test exists for: a substring match instead of a line-anchored one. A goal that
   * merely TALKS about the sentinel — "print NEEDS-HUMAN: if you get stuck" is a natural thing for a
   * person to write, and the agent will echo it back — would park every such run forever.
   */
  it("ignores the sentinel mid-line, so a run that merely mentions it does not block", () => {
    expect(parseBlockRequest(`Done. I was told to say ${RUN_BLOCK_SENTINEL} if stuck, but I was not stuck.`)).toBeNull();
  });

  it("is null for ordinary output and for no output at all", () => {
    expect(parseBlockRequest("FINAL: drafted the essay")).toBeNull();
    expect(parseBlockRequest(null)).toBeNull();
    expect(parseBlockRequest("")).toBeNull();
  });

  it("still blocks when the agent gives no reason — the ask is the signal, not the words", () => {
    expect(parseBlockRequest(RUN_BLOCK_SENTINEL)).toBe("The run asked for a human but gave no reason.");
  });
});

describe("RunConstraintsSchema", () => {
  /**
   * The safety line, checked at the schema edge: an unattended run cannot even ASK for
   * bypassPermissions. `agent_run` degrades a requested bypass to `default`; a run is rejected, so
   * the caller finds out at create time rather than discovering later that their run was not running
   * the way they asked.
   */
  it("has no bypassPermissions to request", () => {
    expect(RunConstraintsSchema.safeParse({ permissionMode: "bypassPermissions" }).success).toBe(false);
    for (const mode of ["plan", "default", "acceptEdits"]) {
      expect(RunConstraintsSchema.safeParse({ permissionMode: mode }).success).toBe(true);
    }
  });

  it("carries no time budget — a run's bound is a wall-clock deadline that survives a restart", () => {
    expect(Object.keys(RunConstraintsSchema.shape)).not.toContain("timeoutMs");
    expect(Object.keys(RunConstraintsSchema.shape)).not.toContain("maxTurns");
  });
});
