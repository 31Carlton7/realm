import { describe, expect, it } from "vitest"; import { AsyncQueue } from "./event-queue";
describe("AsyncQueue", () => {
  it("yields pushed values in order and ends on close", async () => {
    const q = new AsyncQueue<number>(); const out: number[] = [];
    const p = (async () => { for await (const v of q) out.push(v); })();
    q.push(1); q.push(2); await Promise.resolve(); q.push(3); q.close(); await p;
    expect(out).toEqual([1, 2, 3]);
  });
  it("awaits when empty", async () => {
    const q = new AsyncQueue<string>(); const it = q[Symbol.asyncIterator](); const next = it.next();
    q.push("x"); expect((await next).value).toBe("x"); q.close(); expect((await it.next()).done).toBe(true);
  });
});
describe("AsyncQueue edge cases", () => {
  it("drops pushes after close", async () => {
    const q = new AsyncQueue<number>(); q.close(); q.push(1);
    expect(q.isClosed).toBe(true);
    expect((await q[Symbol.asyncIterator]().next()).done).toBe(true);
  });
  it("close with buffered items drains them, then reports done", async () => {
    const q = new AsyncQueue<number>(); q.push(1); q.push(2); q.close();
    const it = q[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: 1, done: false });
    expect(await it.next()).toEqual({ value: 2, done: false });
    expect((await it.next()).done).toBe(true);
  });
});
