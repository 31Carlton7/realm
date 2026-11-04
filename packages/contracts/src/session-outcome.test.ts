import { describe, expect, it } from "vitest";
import { failureReason, sessionOutcome, type OutcomeEvent } from "./session-outcome";

const call = (id: string, command: string, name = "Bash"): OutcomeEvent => ({ type: "tool_call", payload: { toolUseId: id, name, input: { command } } });
const result = (id: string, content: string, isError = false): OutcomeEvent => ({ type: "tool_result", payload: { toolUseId: id, content, isError } });

describe("what a session produced", () => {
  it("reads a PR it opened off the URL gh printed back", () => {
    expect(sessionOutcome([call("1", "gh pr create --base main --fill"), result("1", "https://github.com/31Carlton7/realm/pull/269\n")]))
      .toEqual({ kind: "pr", number: 269, url: "https://github.com/31Carlton7/realm/pull/269", merged: false });
  });

  it("reads a merge by the number it was given, or the one gh said it merged", () => {
    expect(sessionOutcome([call("1", "gh pr merge 264 --squash"), result("1", "")])).toEqual({ kind: "pr", number: 264, url: null, merged: true });
    expect(sessionOutcome([call("1", "gh pr merge --squash"), result("1", "✓ Merged pull request 31Carlton7/realm#258 (Fix it)")]))
      .toEqual({ kind: "pr", number: 258, url: null, merged: true });
  });

  it("takes the last pull request, and a release over any of them", () => {
    const opened = [call("1", "gh pr create"), result("1", "https://github.com/a/b/pull/1"), call("2", "gh pr merge 1"), result("2", "")];
    expect(sessionOutcome(opened)).toMatchObject({ kind: "pr", number: 1, merged: true });
    expect(sessionOutcome([call("0", "gh release create v2.7.2 --notes x"), result("0", "https://github.com/a/b/releases/tag/v2.7.2"), ...opened]))
      .toEqual({ kind: "release", tag: "v2.7.2" });
  });

  it("claims nothing for a command that failed, never answered, or only talked about a PR", () => {
    // THE MUTANTS: a failed create credited; a call with no result credited; a PR URL in a read file credited.
    expect(sessionOutcome([call("1", "gh pr create"), result("1", "https://github.com/a/b/pull/9", true)])).toBeNull();
    expect(sessionOutcome([call("1", "gh pr create")])).toBeNull();
    expect(sessionOutcome([call("1", "cat notes.md"), result("1", "see https://github.com/a/b/pull/9")])).toBeNull();
    expect(sessionOutcome([call("1", "gh pr create", "Read"), result("1", "https://github.com/a/b/pull/9")])).toBeNull();
  });

  it("keeps an error's first line, clipped", () => {
    expect(failureReason("\nNotarization keychain item missing\nstack…")).toBe("Notarization keychain item missing");
    expect(failureReason("x".repeat(200))).toHaveLength(80);
  });
});
