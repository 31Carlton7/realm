import { describe, expect, it } from "vitest";
import { appendDelta, sessionEvent, withStreamed, type StoredSessionEvent } from "./session-events";

const delta = (messageId: string, text: string, at: number): StoredSessionEvent => ({ seq: -1, sessionId: "s", event: sessionEvent("assistant_delta", { messageId, delta: text, at }, 1) });
const stored = (seq: number, event: StoredSessionEvent["event"]): StoredSessionEvent => ({ seq, sessionId: "s", event });
const said = (events: StoredSessionEvent[]) => events.map((e) => e.event.type === "assistant_delta" ? `${e.event.payload.messageId}+${e.event.payload.delta}@${e.event.payload.at}` : `#${e.seq}`);

describe("appendDelta", () => {
  it("adds only what the text does not already hold", () => {
    expect(appendDelta("Reading the", " fixtures", 11)).toBe("Reading the fixtures");
    expect(appendDelta("Reading the", "the", 8)).toBe("Reading the");
    expect(appendDelta("Reading the", "the fix", 8)).toBe("Reading the fix");
  });

  it("appends a delta with no place, or one past the end, as it is", () => {
    expect(appendDelta("Reading", " the")).toBe("Reading the");
    expect(appendDelta("Reading", "fixtures", 12)).toBe("Readingfixtures");
  });
});

describe("withStreamed", () => {
  it("puts the streamed text where the read was taken, and drops the deltas from before it", () => {
    const arrived = [delta("m1", "Hi", 0), stored(3, sessionEvent("assistant_text", { messageId: "m1", text: "Hi" })), delta("m2", "Read", 0), delta("m2", "ing", 4), stored(4, sessionEvent("usage", { costUsd: 0 } as never))];
    expect(said(withStreamed("s", arrived, { seq: 3, message: { messageId: "m2", text: "Read", ts: 1 } }))).toEqual(["#3", "m2+Read@0", "m2+Read@0", "m2+ing@4", "#4"]);
  });

  it("with nothing streaming, keeps the events as they came after the read", () => {
    const arrived = [delta("m1", "Hi", 0), stored(3, sessionEvent("assistant_text", { messageId: "m1", text: "Hi" })), delta("m2", "Next", 0)];
    expect(said(withStreamed("s", arrived, { seq: 3, message: null }))).toEqual(["#3", "m2+Next@0"]);
    expect(said(withStreamed("s", arrived, { seq: 2, message: null }))).toEqual(["m1+Hi@0", "#3", "m2+Next@0"]);
  });
});
