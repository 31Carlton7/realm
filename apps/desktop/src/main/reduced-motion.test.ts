import { describe, expect, it } from "vitest";
import { applyReducedMotion, type MotionTarget } from "./reduced-motion";

function target(attached = false, destroyed = false) {
  const sent: { method: string; params?: object }[] = [];
  let attaches = 0;
  let on = attached;
  const t: MotionTarget = {
    isDestroyed: () => destroyed,
    debugger: {
      isAttached: () => on,
      attach: () => { attaches++; on = true; },
      sendCommand: async (method, params) => { sent.push({ method, params }); return {}; },
    },
  };
  return { t, sent, attaches: () => attaches };
}

const feature = (sent: { params?: object }[]) =>
  (sent.at(-1)?.params as { features: { name: string; value: string }[] } | undefined)?.features;

describe("the reduced-motion override", () => {
  it("On makes the window report the system's own 'reduce', through the media feature every rule reads", () => {
    // THE parallel-mechanism mutant would set an attribute the stylesheet has no rule for. This is
    // the one question the motion rules already ask, answered differently.
    const { t, sent, attaches } = target();
    return applyReducedMotion(t, "on").then(() => {
      expect(attaches()).toBe(1);
      expect(sent.map((s) => s.method)).toEqual(["Emulation.setEmulatedMedia"]);
      expect(feature(sent)).toEqual([{ name: "prefers-reduced-motion", value: "reduce" }]);
    });
  });

  it("Off reports no preference even where the Mac asks for less motion", async () => {
    const { t, sent } = target();
    await applyReducedMotion(t, "off");
    expect(feature(sent)).toEqual([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  });

  it("System lifts an override that is there, and opens no session to lift one that is not", async () => {
    const fresh = target();
    await applyReducedMotion(fresh.t, "system");
    // THE eager mutant: attach for every window just to say "no override".
    expect(fresh.attaches()).toBe(0);
    expect(fresh.sent).toEqual([]);
    const held = target(true);
    await applyReducedMotion(held.t, "system");
    expect(held.attaches()).toBe(0); // already attached — reused, never doubled
    expect(feature(held.sent)).toEqual([{ name: "prefers-reduced-motion", value: "" }]);
  });

  it("ignores a value it does not know, and a window that is gone", async () => {
    for (const junk of ["reduce", true, null, 3]) {
      const { t, sent, attaches } = target();
      await applyReducedMotion(t, junk);
      expect([sent.length, attaches()]).toEqual([0, 0]);
    }
    const gone = target(false, true);
    await applyReducedMotion(gone.t, "on");
    expect(gone.sent).toEqual([]);
  });
});
