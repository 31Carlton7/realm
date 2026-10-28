import { describe, expect, it } from "vitest";
import { adaptIdleMinutes } from "./resources";

describe("an idle window under memory pressure", () => {
  it("shrinks to ten minutes when memory is short and five when it is critical, and never grows", () => {
    expect(adaptIdleMinutes(30, "normal", true)).toBe(30);
    expect(adaptIdleMinutes(30, "unknown", true)).toBe(30);
    expect(adaptIdleMinutes(30, "warn", true)).toBe(10);
    expect(adaptIdleMinutes(30, "critical", true)).toBe(5);
    // A window already shorter stays as it was set.
    expect(adaptIdleMinutes(3, "warn", true)).toBe(3);
  });

  it("leaves never as never, and the settings' own windows when switched off", () => {
    expect(adaptIdleMinutes(0, "critical", true)).toBe(0);
    expect(adaptIdleMinutes(30, "critical", false)).toBe(30);
  });
});
