import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Transcript } from "./Transcript";
import { stampLabel, stampTitle } from "./timestamps";
import type { Block, Transcript as TranscriptModel } from "./transcript-model";

afterEach(cleanup);

const model = (blocks: Block[]): TranscriptModel =>
  ({ blocks, run: null, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, feedback: {}, summary: null, promptHint: null });

const sentA = new Date(2026, 9, 2, 19, 38).getTime();
const sentB = new Date(2026, 9, 3, 8, 5).getTime();

describe("when the user's messages were sent", () => {
  it("dates each message from its own event, never from the moment it was drawn", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([
      { kind: "user", text: "first", ts: sentA },
      { kind: "assistant", messageId: "m1", text: "ok", streaming: false, ts: sentA + 4_000 },
      { kind: "user", text: "second", ts: sentB },
    ])} />);
    const times = [...document.querySelectorAll<HTMLElement>(".msg-user-row .msg-user-at")];
    expect(times.map((t) => t.getAttribute("datetime"))).toEqual([new Date(sentA).toISOString(), new Date(sentB).toISOString()]);
    expect(times.map((t) => t.textContent)).toEqual([stampLabel(sentA, Date.now()), stampLabel(sentB, Date.now())]);
    // The full moment is one hover away, and is what a screen reader hears.
    expect(times[0]!.title).toBe(stampTitle(sentA));
    expect(times[0]!.getAttribute("aria-label")).toBe(`Sent ${stampTitle(sentA)}`);
  });

  it("can be reached from the keyboard, not only revealed by a pointer", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([{ kind: "user", text: "hi", ts: sentA }])} />);
    const time = document.querySelector<HTMLElement>(".msg-user-at")!;
    expect(time.tabIndex).toBe(0);
    time.focus();
    expect(document.activeElement).toBe(time);
  });

  it("dates an attachment-only message and a peer's question too", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([
      { kind: "user", text: "", attachments: [{ path: "/tmp/a.png", mime: "image/png" }], ts: sentA },
      { kind: "user", text: "from a peer", from: { sessionId: "s2", title: "Other" }, ts: sentB },
    ])} />);
    expect(document.querySelectorAll(".msg-user-at")).toHaveLength(2);
  });
});

describe("the line a turn settles into", () => {
  const ts = new Date(2026, 9, 2, 23, 58).getTime();
  const run = (extra: Partial<Extract<Block, { kind: "run" }>>): Block => ({ kind: "run", ms: 4_000, startedAt: ts - 4_000, ts, ...extra });
  const line = () => document.querySelector(".msg-run > span:first-child")!.textContent;

  it("says a failed turn failed, with how long it ran and when it ended", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([run({ failed: true })])} />);
    expect(line()).toBe("Failed after 4s");
    expect(document.querySelector(".msg-run-at")!.textContent).toBe(stampLabel(ts, Date.now()));
  });

  it("says a stopped turn stopped", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([run({ stopped: true })])} />);
    expect(line()).toBe("Stopped after 4s");
  });

  it("says plainly how long a turn it could only measure from the outside took", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([run({ derived: true })])} />);
    expect(line()).toBe("Worked for 4s");
  });

  it("reads hours past the hour, on a run that long", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([run({ ms: 3_840_000, stopped: true })])} />);
    expect(line()).toBe("Stopped after 1h 4m");
  });
});
