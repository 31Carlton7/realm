import { describe, expect, it, vi } from "vitest";
import { RANGE_PIECE, rangeAnswerer, readPieces } from "./range-reads";

/** A file of `size` bytes behind main's ceiling: a read past RANGE_PIECE is refused, as main refuses it. */
const fileOf = (size: number) => {
  const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
  const read = vi.fn(async (start: number, length: number) => (length > RANGE_PIECE ? null : bytes.slice(start, start + length)));
  return { bytes, read };
};

describe("a card's PDF reads", () => {
  it("reads a range larger than one read allows in pieces, and hands it on whole", async () => {
    // pdf.js asks for a scanned page's image stream as ONE range. THE MUTANT: one read for the whole
    // range, which main refuses past its ceiling, and the page never arrives.
    const { bytes, read } = fileOf(RANGE_PIECE * 2 + 500);
    const deliver = vi.fn();
    const fail = vi.fn();
    rangeAnswerer(read, deliver, fail)(100, RANGE_PIECE * 2 + 400);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const [begin, chunk] = deliver.mock.calls[0]! as [number, Uint8Array];
    expect(begin).toBe(100);
    // Compared byte by byte: `toEqual` on two megabytes takes seconds, and timed the test out on CI.
    expect(chunk.byteLength).toBe(RANGE_PIECE * 2 + 300);
    expect(chunk.every((b, i) => b === bytes[100 + i])).toBe(true);
    expect(read.mock.calls.map(([, length]) => length)).toEqual([RANGE_PIECE, RANGE_PIECE, 300]);
    expect(fail).not.toHaveBeenCalled();
  });

  it("fails the page when a read comes back with nothing, rather than leaving pdf.js waiting", async () => {
    // THE MUTANT: a null read dropped, which is the hang — pdf.js waits on a range forever.
    const deliver = vi.fn();
    const fail = vi.fn();
    const ask = rangeAnswerer(async () => null, deliver, fail);
    ask(0, 10);
    await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(1));
    ask(10, 20);
    await new Promise((r) => setTimeout(r, 0));
    expect(fail).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(await readPieces(async () => new Uint8Array(0), 0, 10)).toBeNull();
  });

  it("fails a page that would cost more than its budget, without reading it", async () => {
    const { read } = fileOf(64);
    const deliver = vi.fn();
    const fail = vi.fn();
    const ask = rangeAnswerer(read, deliver, fail, 100);
    ask(0, 60);
    ask(60, 120);
    await vi.waitFor(() => expect(fail).toHaveBeenCalledTimes(1));
    expect(read.mock.calls.map(([start]) => start)).toEqual([0]);
  });
});
