import { describe, expect, it } from "vitest";
import { FrameReader, MAX_FRAGMENT, MAX_FRAME, sealMessage } from "../src/frames";
import { CipherState, NoiseError } from "../src/noise";

const key = Buffer.alloc(32, 3);
const pair = () => ({ send: new CipherState(key), receive: new CipherState(key) });

describe("transport framing", () => {
  it("a message that fits is one frame, and a long one is split under the Noise limit", () => {
    const { send } = pair();
    expect(sealMessage(send, "{}")).toHaveLength(1);
    const frames = sealMessage(send, JSON.stringify({ text: "x".repeat(200_000) }));
    expect(frames).toHaveLength(4);
    expect(frames.every((f) => f.length <= MAX_FRAME)).toBe(true);
  });

  it("joins fragments back into the message, across fragment boundaries in multi-byte text", () => {
    const { send, receive } = pair();
    const reader = new FrameReader(receive);
    const message = JSON.stringify({ text: "€".repeat(MAX_FRAGMENT) });
    const frames = sealMessage(send, message);
    const out = frames.map((f) => reader.push(f));
    expect(out.slice(0, -1).every((x) => x === null)).toBe(true);
    expect(out.at(-1)).toBe(message);
  });

  it("refuses frames out of order, since the nonce is the order", () => {
    const { send, receive } = pair();
    const reader = new FrameReader(receive);
    const [a, b] = [sealMessage(send, '{"n":1}')[0]!, sealMessage(send, '{"n":2}')[0]!];
    expect(() => reader.push(b)).toThrow(NoiseError);
    expect(reader.push(a)).toBe('{"n":1}');
  });

  it("refuses a message larger than the reader will hold", () => {
    const { send, receive } = pair();
    const reader = new FrameReader(receive, 100_000);
    const frames = sealMessage(send, "y".repeat(150_000));
    expect(() => frames.forEach((f) => reader.push(f))).toThrow(/too large/);
  });
});
