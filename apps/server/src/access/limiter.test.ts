import { describe, expect, it } from "vitest";
import { HandshakeLimiter } from "./limiter";

describe("HandshakeLimiter", () => {
  it("blocks an address on its tenth refusal inside a minute, for a minute, and says so once", () => {
    let now = 0;
    const l = new HandshakeLimiter({ now: () => now });
    const blockedOn: number[] = [];
    for (let i = 1; i <= 12; i++) { if (l.fail("203.0.113.9")) blockedOn.push(i); now += 1_000; }
    expect(blockedOn).toEqual([10]);
    expect(l.blocked("203.0.113.9")).toBe(true);
    expect(l.blocked("198.51.100.1")).toBe(false); // another address keeps its own budget
    now += 60_000;
    expect(l.blocked("203.0.113.9")).toBe(false);
  });

  it("forgives refusals spread thinner than the window", () => {
    let now = 0;
    const l = new HandshakeLimiter({ now: () => now });
    for (let i = 0; i < 30; i++) { l.fail("203.0.113.9"); now += 7_000; }
    expect(l.blocked("203.0.113.9")).toBe(false);
  });

  it("clears an address's refusals when it gets in, but not while it is blocked", () => {
    let now = 0;
    const l = new HandshakeLimiter({ now: () => now, max: 3 });
    l.fail("a"); l.fail("a");
    l.succeed("a");
    l.fail("a"); l.fail("a");
    expect(l.blocked("a")).toBe(false);
    l.fail("a");
    expect(l.blocked("a")).toBe(true);
    l.succeed("a"); // a valid token does not lift a block: that is what makes it a block
    expect(l.blocked("a")).toBe(true);
  });

  it("keeps a bounded number of addresses", () => {
    const l = new HandshakeLimiter({ capacity: 100, max: 2 });
    for (let i = 0; i < 1_000; i++) l.fail(`10.0.${i >> 8}.${i & 255}`);
    expect((l as unknown as { entries: Map<string, unknown> }).entries.size).toBe(100);
  });
});
