import { afterEach, describe, expect, it, vi } from "vitest";
import { GUIDE_STATE_MARK, GUIDE_STATE_MAX_CHARS } from "@realm/contracts";
import { STORAGE_WRITE_MS, guideEnvelope, guideStateFrom, notePersisted, persistStorage } from "./guide-state";

afterEach(() => { vi.useRealTimers(); });

describe("guideStateFrom — what a frame posts is checked before it is kept", () => {
  it("takes the runtime's shape and refuses anything else", () => {
    const ok = { v: 1, hash: "#u", top: 10, local: { a: "1" }, session: {}, widgets: { "q0:x": { a: [[1]], k: 0 } } };
    expect(guideStateFrom(ok)).toEqual(ok);
    for (const bad of [null, "x", [], { v: 2 }, { v: 1, hash: 3 }, { v: 1, top: "1" }, { v: 1, local: { a: 1 } }, { v: 1, session: [] }, { v: 1, widgets: [] }]) {
      expect(guideStateFrom(bad)).toBeNull();
    }
  });

  it("refuses a state larger than a guide may keep", () => {
    /* THE MUTANT: drop the size check. A page that posts its storage in a loop grows the renderer's
       memory, and the sidecar, without bound. */
    expect(guideStateFrom({ v: 1, local: { big: "x".repeat(GUIDE_STATE_MAX_CHARS) } })).toBeNull();
    expect(guideStateFrom({ v: 1, local: { big: "x".repeat(1000) } })).not.toBeNull();
  });
});

describe("guideEnvelope — the frame's name", () => {
  it("names the document, carries the state with the scroll in it, and is empty when there is nothing to hand", () => {
    expect(guideEnvelope("d/g.html", null, null)).toBe("");
    expect(guideEnvelope("d/g.html", null, 0)).toBe("");
    expect(JSON.parse(guideEnvelope("d/g.html", { v: 1, local: { a: "1" } }, 300))).toEqual({ k: GUIDE_STATE_MARK, doc: "d/g.html", state: { v: 1, local: { a: "1" }, top: 300 } });
    expect(JSON.parse(guideEnvelope("d/g.html", null, 50))).toEqual({ k: GUIDE_STATE_MARK, doc: "d/g.html", state: { v: 1, top: 50 } });
  });
});

describe("persistStorage — the guide's storage, written through to its sidecar", () => {
  it("writes the last of a burst once, and nothing for a state that leaves storage as it was", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const write = async (s: Record<string, string>) => { writes.push(JSON.stringify(s)); };
    notePersisted("k", { a: "1" });
    /* THE MUTANT: drop the comparison with what the sidecar holds. Every flipped card and every step
       taken rewrites the sidecar with the storage it already has. */
    persistStorage("k", { a: "1" }, write);
    await vi.advanceTimersByTimeAsync(STORAGE_WRITE_MS + 50);
    expect(writes).toEqual([]);
    persistStorage("k", { a: "2" }, write);
    persistStorage("k", { a: "3" }, write);
    await vi.advanceTimersByTimeAsync(STORAGE_WRITE_MS + 50);
    expect(writes).toEqual(['{"a":"3"}']);
    persistStorage("k", { a: "3" }, write);
    await vi.advanceTimersByTimeAsync(STORAGE_WRITE_MS + 50);
    expect(writes).toHaveLength(1);
    // Cleared by the guide: written as empty, which takes the storage out of the sidecar.
    persistStorage("k", {}, write);
    await vi.advanceTimersByTimeAsync(STORAGE_WRITE_MS + 50);
    expect(writes).toEqual(['{"a":"3"}', "{}"]);
  });

  it("makes no sidecar for a guide that has never kept anything", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    persistStorage("fresh", {}, write);
    await vi.advanceTimersByTimeAsync(STORAGE_WRITE_MS + 50);
    expect(write).not.toHaveBeenCalled();
  });

  it("tries again after a write that failed", async () => {
    vi.useFakeTimers();
    let fail = true;
    const writes: string[] = [];
    const write = async (s: Record<string, string>) => { if (fail) throw new Error("disk"); writes.push(JSON.stringify(s)); };
    persistStorage("k2", { a: "1" }, write);
    await vi.advanceTimersByTimeAsync(STORAGE_WRITE_MS + 50);
    fail = false;
    persistStorage("k2", { a: "1" }, write);
    await vi.advanceTimersByTimeAsync(STORAGE_WRITE_MS + 50);
    expect(writes).toEqual(['{"a":"1"}']);
  });
});
