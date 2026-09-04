import { describe, expect, it } from "vitest";
import { dayPart, heroGreeting, type GreetingPart } from "./greeting";

const text = (parts: GreetingPart[]) => parts.map((p) => p.text).join("");
const at = (hour: number) => new Date(2026, 8, 3, hour, 0, 0);
/** Every greeting the pool can produce for these inputs — one per seed until the set stops growing. */
const all = (o: { spaceName: string; userName?: string; at?: Date }) =>
  new Set(Array.from({ length: 200 }, (_, i) => text(heroGreeting({ ...o, seed: `s${i}` }))));

describe("dayPart", () => {
  it("splits the day at 5, 12 and 18, and calls the small hours evening", () => {
    expect(dayPart(at(5))).toBe("morning");
    expect(dayPart(at(11))).toBe("morning");
    expect(dayPart(at(12))).toBe("afternoon");
    expect(dayPart(at(17))).toBe("afternoon");
    expect(dayPart(at(18))).toBe("evening");
    expect(dayPart(at(23))).toBe("evening");
    expect(dayPart(at(2))).toBe("evening");
    expect(dayPart(at(4))).toBe("evening");
  });
});

describe("heroGreeting", () => {
  it("is stable for a session and varies across sessions", () => {
    const one = text(heroGreeting({ spaceName: "Versed", seed: "se1" }));
    expect(text(heroGreeting({ spaceName: "Versed", seed: "se1" }))).toBe(one);
    expect(all({ spaceName: "Versed" }).size).toBeGreaterThan(1);
  });

  it("never asks what we are BUILDING — a space is as often a course as a repo", () => {
    for (const g of all({ spaceName: "Versed", userName: "Carlton" })) expect(g).not.toMatch(/build/i);
  });

  it("marks the space (and the person) as the varying words, so the rest is plain copy", () => {
    for (let i = 0; i < 200; i++) {
      const parts = heroGreeting({ spaceName: "Versed", userName: "Carlton", seed: `s${i}` });
      const emphasised = parts.filter((p) => p.em).map((p) => p.text);
      expect(emphasised.length).toBeGreaterThan(0);
      for (const e of emphasised) expect(["Versed", "Carlton"]).toContain(e);
      // Nothing but the proper nouns is emphasised — the plain runs carry no stray name.
      for (const p of parts) if (!p.em) expect(p.text).not.toMatch(/Versed|Carlton/);
    }
  });

  it("greets by name and by hour only when a name is known", () => {
    const anonymous = all({ spaceName: "Versed", at: at(19) });
    for (const g of anonymous) {
      expect(g).not.toMatch(/Good (morning|afternoon|evening)/);
      expect(g).toContain("Versed"); // with no name to use, every line names the space
    }
    const named = all({ spaceName: "Versed", userName: "Carlton", at: at(19) });
    expect([...named].some((g) => g.startsWith("Good evening, Carlton"))).toBe(true);
    // The named variants are additions, not replacements: the space-only lines stay in the pool.
    for (const g of anonymous) expect(named.has(g)).toBe(true);
  });

  it("takes the greeting's hour from `at`", () => {
    const morning = all({ spaceName: "Versed", userName: "Carlton", at: at(9) });
    expect([...morning].some((g) => g.startsWith("Good morning, Carlton"))).toBe(true);
    expect([...morning].some((g) => g.includes("Good evening"))).toBe(false);
  });

  it("treats a blank name as no name at all", () => {
    for (const g of all({ spaceName: "Versed", userName: "   ", at: at(19) })) {
      expect(g).not.toMatch(/Good evening/);
      expect(g).not.toMatch(/,\s*\?/); // and never a dangling comma where the name would have gone
    }
  });
});
