import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Transcript } from "./Transcript";
import { reduceTranscript, emptyTranscript, type Block, type Transcript as TranscriptModel } from "./transcript-model";
import { sessionEvent } from "@realm/contracts";

afterEach(cleanup);

const model = (blocks: Block[]): TranscriptModel =>
  ({ blocks, run: null, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, feedback: {}, summary: null, promptHint: null });

const PATH = "/realm/handoffs/s1/handoff-1.md";

describe("the line a switch of agents leaves", () => {
  it("names both models and opens the hand-off note beside the session", () => {
    const t = reduceTranscript(emptyTranscript(), sessionEvent("handoff", {
      from: "claude", to: "codex", reason: "switch", note: "Switched from Claude Opus 5.5 to Codex GPT-5.6", attempt: 0, summaryPath: PATH,
    }), false);
    const opened: string[] = [];
    render(<Transcript transcript={t} sessionStatus="idle" onDecide={() => {}} checkout={{ root: "/work/app", onOpen: (p) => opened.push(p) }} />);
    const seam = document.querySelector(".msg-handoff")!;
    expect(seam).toHaveTextContent("Switched from Claude Opus 5.5 to Codex GPT-5.6·Summary");
    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    expect(opened).toEqual([PATH]);
  });

  it("offers no link where there is no note, or nowhere to open one", () => {
    render(<Transcript transcript={model([{ kind: "handoff", from: "claude", to: "codex", note: "Claude hit its usage limit. Continuing on Codex.", attempt: 0, ts: 1 }])}
      sessionStatus="idle" onDecide={() => {}} checkout={{ root: "/w", onOpen: () => {} }} />);
    expect(screen.queryByRole("button", { name: "Summary" })).toBeNull();
    cleanup();
    render(<Transcript transcript={model([{ kind: "handoff", from: "claude", to: "codex", note: "Switched", attempt: 0, summaryPath: PATH, ts: 1 }])}
      sessionStatus="idle" onDecide={() => {}} />);
    expect(screen.queryByRole("button", { name: "Summary" })).toBeNull();
  });
});

describe("a usage limit on one of the agent's accounts", () => {
  const limited = (): Block => ({ kind: "error", message: "Personal hit its usage limit.", accounts: [{ id: "work", label: "Work" }], ts: 2 });

  it("offers the agent's other accounts on the error the last turn ended on", () => {
    const chose: string[] = [];
    render(<Transcript transcript={model([{ kind: "user", text: "go", ts: 1 } as Block, limited()])} sessionStatus="idle" onDecide={() => {}}
      onContinueOn={(id) => chose.push(id)} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue on Work" }));
    expect(chose).toEqual(["work"]);
  });

  it("withdraws the offer once something else has been sent", () => {
    render(<Transcript transcript={model([limited(), { kind: "user", text: "never mind", ts: 3 } as Block])} sessionStatus="idle" onDecide={() => {}}
      onContinueOn={() => {}} />);
    expect(screen.queryByRole("button", { name: "Continue on Work" })).toBeNull();
  });
});
