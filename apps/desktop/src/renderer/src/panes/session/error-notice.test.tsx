import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Transcript, isProseError } from "./Transcript";
import type { Block, Transcript as TranscriptModel } from "./transcript-model";

afterEach(cleanup);

const model = (blocks: Block[]): TranscriptModel =>
  ({ blocks, run: null, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, feedback: {}, summary: null, promptHint: null });

describe("the error notice", () => {
  it("sets a sentence in the interface face, and real output in mono", () => {
    // "The agent's CLI exited before it answered." was a red mono <pre>, read as captured stderr.
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([
      { kind: "error", message: "The agent's CLI exited before it answered.", ts: 1 },
      { kind: "error", message: "Error: spawn claude ENOENT\n    at Process.ChildProcess._handle.onexit (node:internal/child_process:285:19)", ts: 2 },
    ])} />);
    const [prose, output] = [...document.querySelectorAll(".msg-error-body")];
    expect(prose!.querySelector("p.msg-error-text")!.textContent).toBe("The agent's CLI exited before it answered.");
    expect(prose!.querySelector("pre")).toBeNull();
    expect(output!.querySelector("pre")!.textContent).toMatch(/^Error: spawn claude ENOENT/);
  });

  it("keeps a one-line message that is output, not prose, in the mono box", () => {
    expect(isProseError("Error: rate limited.")).toBe(false);
    expect(isProseError("ENOENT: no such file or directory, open '/x'")).toBe(false);
    expect(isProseError("request failed with status 500")).toBe(false);
    expect(isProseError("You're out of usage on this account until 3 PM.")).toBe(true);
  });
});
