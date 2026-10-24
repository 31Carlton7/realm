import { describe, expect, it } from "vitest";
import { encode } from "uqr";
import { pairingLink } from "../../state/store.test-fakes";
import { clockLabel, phoneDetail, phoneModelName, qrCode, QUIET_ZONE, sinceLabel } from "./devices";

describe("a phone's model", () => {
  it("is the marketing name for an identifier Realm knows", () => {
    expect(phoneModelName("iPhone18,1")).toBe("iPhone 17 Pro");
    expect(phoneModelName("iPhone18,4")).toBe("iPhone Air");
    expect(phoneModelName("iPhone17,5")).toBe("iPhone 16e");
    expect(phoneModelName("iPhone12,1")).toBe("iPhone 11");
  });

  it("is the identifier itself for one it does not — a wrong name is worse than the code", () => {
    expect(phoneModelName("iPhone19,1")).toBe("iPhone19,1");
    expect(phoneModelName("Simulator")).toBe("Simulator");
    // An own-property lookup, so nothing on Object's prototype passes for a model.
    expect(phoneModelName("toString")).toBe("toString");
  });
});

describe("when a phone was last heard from", () => {
  const now = Date.UTC(2026, 9, 8, 12);
  it("reads the way the plan writes it", () => {
    expect(sinceLabel(now - 20_000, now)).toBe("just now");
    expect(sinceLabel(now - 4 * 60_000, now)).toBe("4 min ago");
    expect(sinceLabel(now - 60 * 60_000, now)).toBe("1 hour ago");
    expect(sinceLabel(now - 5 * 60 * 60_000, now)).toBe("5 hours ago");
    expect(sinceLabel(now - 30 * 60 * 60_000, now)).toBe("yesterday");
    expect(sinceLabel(now - 3 * 24 * 60 * 60_000, now)).toBe("3 days ago");
    expect(sinceLabel(now - 90 * 24 * 60 * 60_000, now)).toMatch(/^on /);
    // A clock a little ahead of the server's is not "in the future".
    expect(sinceLabel(now + 5_000, now)).toBe("just now");
  });

  it("names the model and the last time it was seen — or, never seen since pairing, when it was paired", () => {
    const phone = { phoneId: "p1", name: "Carlton's iPhone", model: "iPhone18,1", addedAt: now - 2 * 24 * 60 * 60_000, lastSeen: now - 4 * 60_000 };
    expect(phoneDetail(phone, now)).toBe("iPhone 17 Pro · Last seen 4 min ago");
    expect(phoneDetail({ ...phone, lastSeen: null }, now)).toBe("iPhone 17 Pro · Paired 2 days ago");
  });
});

describe("the code's time left", () => {
  it("counts like a clock and stops at zero", () => {
    expect(clockLabel(5 * 60_000)).toBe("5:00");
    expect(clockLabel(4 * 60_000 + 59_001)).toBe("5:00");
    expect(clockLabel(4 * 60_000 + 59_000)).toBe("4:59");
    expect(clockLabel(9_000)).toBe("0:09");
    expect(clockLabel(-3_000)).toBe("0:00");
  });
});

describe("the QR code", () => {
  const url = pairingLink("Wx2k9Qy7RZ0aYb3cDe4fGg", Date.UTC(2026, 9, 8, 12, 5));

  /** The path's rectangles back on a grid, to read the drawing rather than the string. */
  function drawn(code: { size: number; path: string }): boolean[][] {
    const grid = Array.from({ length: code.size }, () => Array<boolean>(code.size).fill(false));
    for (const m of code.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      const [x, y, run] = [Number(m[1]), Number(m[2]), Number(m[3])];
      for (let i = 0; i < run; i++) grid[y]![x + i] = true;
    }
    return grid;
  }

  it("draws exactly the modules the encoder produced, run by run", () => {
    const code = qrCode(url);
    const { data } = encode(url, { ecc: "M", border: QUIET_ZONE });
    // THE run-length mutant: drop the module after a run, or draw one too many.
    expect(drawn(code)).toEqual(data);
  });

  it("keeps the quiet zone the specification asks for, on every side", () => {
    const code = qrCode(url);
    const grid = drawn(code);
    const edge = (i: number) => i < QUIET_ZONE || i >= code.size - QUIET_ZONE;
    const inZone = grid.flatMap((row, y) => row.map((dark, x) => (dark && (edge(x) || edge(y)) ? [x, y] : null))).filter(Boolean);
    expect(inZone).toEqual([]);
    // …and the three finder squares start right where it ends.
    expect(grid[QUIET_ZONE]![QUIET_ZONE]).toBe(true);
    expect(grid[QUIET_ZONE]![code.size - QUIET_ZONE - 1]).toBe(true);
    expect(grid[code.size - QUIET_ZONE - 1]![QUIET_ZONE]).toBe(true);
  });

  it("is the size a real link makes at M, which the sheet draws three pixels a module", () => {
    // A real link is ~370 characters: the production relay, two ids, two keys, the Mac's name and the
    // expiry.
    expect(url.length).toBeGreaterThan(360);
    expect(qrCode(url).size).toBe(85);
  });
});
