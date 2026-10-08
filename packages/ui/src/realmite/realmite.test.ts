import { describe, expect, it } from "vitest";
import { contrast, hexToOklch, parseOklch } from "@realm/contracts";
import { deriveVars, REALM_SEED } from "../themes";
import { REALMITE_CSS } from "./css";
import { animatesAt, detailFor, drawRealmite, realmiteSvg, type SvgNode } from "./draw";
import { bodyOklch, colours, inkOklch, PALETTES, type Face, type PaletteId } from "./parts";
import { customize, parseRealmiteSpec, PART_IDS, realmiteFromSeed, REALMITE_STATES, type RealmiteSpec } from "./spec";

const seeds = (n: number) => Array.from({ length: n }, (_, i) => `seed-${i}`);

describe("realmiteFromSeed", () => {
  it("is deterministic: the same seed is the same creature, every time", () => {
    for (const seed of seeds(300)) expect(realmiteFromSeed(seed)).toEqual(realmiteFromSeed(seed));
    // pinned, so a change to the generator that would redraw every stored-by-seed creature is seen
    expect(realmiteFromSeed("role-1")).toMatchInlineSnapshot(`
      {
        "accessory": "horns",
        "body": "cube",
        "cheeks": false,
        "eyes": "cyclops",
        "mouth": "fang",
        "palette": "orchid",
        "pattern": "none",
        "seed": "role-1",
        "v": 1,
      }
    `);
  });

  it("varies: seeds spread across every part", () => {
    const specs = seeds(400).map(realmiteFromSeed);
    expect(new Set(specs.map((s) => JSON.stringify({ ...s, seed: "" }))).size).toBeGreaterThan(350);
    for (const part of ["body", "palette", "eyes", "mouth", "accessory", "pattern"] as const) {
      expect(new Set(specs.map((s) => s[part])).size, part).toBe(PART_IDS[part].length);
    }
  });

  it("only rolls the combinations that were kept", () => {
    for (const s of seeds(3000).map(realmiteFromSeed)) {
      if (s.body === "drop") expect(["none", "sprout", "bobble"]).toContain(s.accessory);
      if (s.pattern === "facet") expect(s.body).toBe("cube");
      if (s.accessory === "beanie" || s.accessory === "cap") expect(s.pattern).not.toBe("stripes");
      if (s.eyes === "cyclops") {
        expect(s.pattern).not.toBe("faceplate");
        expect(s.cheeks).toBe(false);
      }
    }
  });

  it("is plain JSON", () => {
    const s = realmiteFromSeed("json");
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe("customize", () => {
  const deepFreeze = (s: RealmiteSpec) => Object.freeze({ ...s });

  it("is pure: the input is untouched and a new spec comes back", () => {
    const base = deepFreeze(realmiteFromSeed("pure"));
    const before = JSON.stringify(base);
    const next = customize(base, { body: "mochi", cheeks: !base.cheeks });
    expect(JSON.stringify(base)).toBe(before);
    expect(next).not.toBe(base);
    expect(next).toEqual({ ...base, body: "mochi", cheeks: !base.cheeks });
    expect(customize(base, { body: "mochi", cheeks: !base.cheeks })).toEqual(next);
  });

  it("ignores a value that names no part, so a spec is always drawable", () => {
    const base = realmiteFromSeed("bad");
    expect(customize(base, { body: "dragon" as never, palette: 3 as never, cheeks: "yes" as never })).toEqual(base);
  });

  it("does not reroll the parts when only the seed changes", () => {
    const base = realmiteFromSeed("one");
    expect(customize(base, { seed: "two" })).toEqual({ ...base, seed: "two" });
  });
});

describe("parseRealmiteSpec", () => {
  it("reads back what was stored, string or object", () => {
    const s = customize(realmiteFromSeed("stored"), { eyes: "cyclops", accessory: "cap" });
    expect(parseRealmiteSpec(JSON.stringify(s), "x")).toEqual(s);
    expect(parseRealmiteSpec(s, "x")).toEqual(s);
  });

  it("fills an unknown part from the seed, and garbage from the fallback seed", () => {
    const s = realmiteFromSeed("stored");
    expect(parseRealmiteSpec({ ...s, mouth: "beak" }, "x")).toEqual(s);
    expect(parseRealmiteSpec("{not json", "role-7")).toEqual(realmiteFromSeed("role-7"));
    expect(parseRealmiteSpec(null, "role-7")).toEqual(realmiteFromSeed("role-7"));
  });
});

/* ── Drawing ─────────────────────────────────────────────────────────────── */

const COORD = new Set(["cx", "cy", "x", "y", "r", "rx", "ry", "width", "height"]);

/** Every coordinate in the drawing is a finite number inside the 64-unit square (with a hair of
 *  give for anti-aliasing): a NaN or a part flung off the canvas is what a broken pairing looks like.
 *  Returns the problems rather than asserting each number, so twenty thousand drawings stay fast. */
const inside = (x: number) => Number.isFinite(x) && x >= -1 && x <= 65;
function problems(node: SvgNode, where: string, out: string[] = []): string[] {
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k === "d") {
      const nums = String(v).match(/-?\d*\.?\d+(e-?\d+)?/g) ?? [];
      if (!nums.length) out.push(`${where} empty d`);
      for (const n of nums) if (!inside(Number(n))) out.push(`${where} d ${n}`);
    } else if (COORD.has(k) && node.tag !== "svg") {
      if (!inside(Number(v))) out.push(`${where} ${k}=${v}`);
    } else if (/NaN|undefined|Infinity/.test(String(v))) out.push(`${where} ${k}=${v}`);
  }
  if (node.tag === "circle") {
    const [cx, cy, r] = (["cx", "cy", "r"] as const).map((k) => Number(node.attrs[k])) as [number, number, number];
    for (const edge of [cx - r, cx + r, cy - r, cy + r]) if (!inside(edge)) out.push(`${where} circle edge ${edge}`);
  }
  for (const c of node.children ?? []) problems(c, where, out);
  return out;
}

describe("drawRealmite", () => {
  it("draws every part combination, in every state, at every level of detail", () => {
    const base = realmiteFromSeed("combo");
    const found: string[] = [];
    let n = 0;
    for (const body of PART_IDS.body) for (const accessory of PART_IDS.accessory) for (const pattern of PART_IDS.pattern)
      for (const eyes of PART_IDS.eyes) {
        const mouth = PART_IDS.mouth[n % PART_IDS.mouth.length]!;
        const spec = customize(base, { body, accessory, pattern, eyes, mouth, cheeks: n % 2 === 0 });
        for (const state of REALMITE_STATES) for (const size of [16, 24, 48]) {
          problems(drawRealmite(spec, { size, state, uid: "t" }), `${body}/${accessory}/${pattern}/${eyes}/${mouth} ${state}@${size}`, found);
        }
        n++;
      }
    for (const eyes of PART_IDS.eyes) for (const mouth of PART_IDS.mouth) for (const state of REALMITE_STATES) {
      problems(drawRealmite(customize(base, { eyes, mouth, cheeks: true }), { size: 160, state, uid: "t" }), `${eyes}/${mouth} ${state}`, found);
    }
    expect(n).toBe(PART_IDS.body.length * PART_IDS.accessory.length * PART_IDS.pattern.length * PART_IDS.eyes.length);
    expect(found.slice(0, 10)).toEqual([]);
  });

  it("gives every part a visible difference at full detail", () => {
    const base = customize(realmiteFromSeed("diff"), { accessory: "none", pattern: "none", mouth: "smile", eyes: "dot" });
    for (const part of ["body", "eyes", "mouth", "accessory", "pattern"] as const) {
      const drawn = PART_IDS[part].map((id) => realmiteSvg(customize(base, { [part]: id }), { size: 160, uid: "t" }));
      expect(new Set(drawn).size, part).toBe(PART_IDS[part].length);
    }
  });

  it("holds a distinct still pose for each state, so a Realmite that cannot move still says what it is doing", () => {
    for (const seed of seeds(20)) {
      const spec = realmiteFromSeed(seed);
      for (const size of [24, 160]) {
        const poses = REALMITE_STATES.map((state) => realmiteSvg(spec, { size, state, uid: "t" }).replace(/data-state="[^"]+"|data-animate/g, ""));
        expect(new Set(poses).size, `${seed}@${size}`).toBe(REALMITE_STATES.length);
      }
    }
  });

  it("holds the poses that say it: working looks aside and leans in, asleep its eyes are shut", () => {
    for (const seed of seeds(20)) {
      const spec = realmiteFromSeed(seed);
      const at = (state: (typeof REALMITE_STATES)[number]) => realmiteSvg(spec, { size: 48, state, uid: "t" });
      expect(at("idle")).not.toMatch(/class="rmt-look" transform=/);
      expect(at("working")).toMatch(/class="rmt-look" transform="translate\([1-9]/);
      expect(at("working")).toContain('class="rmt-pose" transform="rotate(-3');
      expect(at("sleeping")).not.toContain("rmt-look");
      expect(at("needs-you")).toContain("rmt-badge");
      expect(at("idle")).not.toContain("rmt-badge");
    }
  });

  it("drops detail as it shrinks: a 16px row keeps the silhouette and the eyes", () => {
    const spec = customize(realmiteFromSeed("lod"), { mouth: "fang", pattern: "spots", cheeks: true, eyes: "shine" });
    const tiny = realmiteSvg(spec, { size: 16, uid: "t" });
    expect(detailFor(16)).toBe("tiny");
    expect(tiny).not.toContain("rmt-c-blush");
    expect(tiny).not.toContain("rmt-s-ink"); // no mouth stroke
    expect(tiny).not.toContain("rmt-c-white"); // no catchlight, no tooth
    expect(realmiteSvg(spec, { size: 160, uid: "t" })).toContain("rmt-c-blush");
  });

  it("is decorative unless it is given a name", () => {
    const spec = realmiteFromSeed("a11y");
    expect(realmiteSvg(spec, { size: 24, uid: "t" })).toContain('aria-hidden="true"');
    const named = realmiteSvg(spec, { size: 24, uid: "t", title: "Creator Manager" });
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="Creator Manager"');
  });
});

/* ── Colour ──────────────────────────────────────────────────────────────── */

const GROUNDS = ["--page", "--canvas", "--surface", "--inset", "--hover", "--hover-2"];

describe("palettes", () => {
  for (const face of ["dark", "light"] as Face[]) {
    const vars = deriveVars(REALM_SEED[face], face);
    for (const id of Object.keys(PALETTES) as PaletteId[]) {
      it(`${id} on the ${face} face: the body clears 3 : 1 on every ground, and its face clears 3 : 1 on the body`, () => {
        const body = bodyOklch(id, face);
        for (const g of GROUNDS) expect(contrast(body, parseOklch(vars[g]!)), `${g}`).toBeGreaterThanOrEqual(3);
        expect(contrast(inkOklch(id), body)).toBeGreaterThanOrEqual(3);
        // what is drawn is the colour that was measured
        expect(contrast(hexToOklch(colours(id, face).body), body)).toBeLessThan(1.02);
      });
    }
  }

  it("keeps clear of the three hues that mean state", () => {
    const stateHues = (["green", "orange", "red"] as const).map((k) => hexToOklch(REALM_SEED.dark[k]).h);
    for (const [id, p] of Object.entries(PALETTES)) {
      if (p.chroma < 0.08) continue; // a near-neutral reads as a material, not a signal
      for (const h of stateHues) {
        const d = Math.min(Math.abs(p.hue - h), 360 - Math.abs(p.hue - h));
        expect(d, `${id} vs ${h.toFixed(0)}`).toBeGreaterThanOrEqual(15);
      }
    }
  });
});

/* ── Motion ──────────────────────────────────────────────────────────────── */

describe("motion", () => {
  it("stops every loop under Reduce motion", () => {
    expect(REALMITE_CSS).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\.rmt,\.rmt \*\{animation:none!important\}\}/);
  });

  it("only animates a drawing that was marked to, and a row-sized one never is", () => {
    const rules = REALMITE_CSS.split("\n").filter((l) => /(^|[;{])animation:/.test(l) && !l.startsWith("@media"));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r.startsWith(".rmt[data-animate]"), r).toBe(true);
    for (const state of REALMITE_STATES) {
      expect(animatesAt(16, state)).toBe(false);
      expect(realmiteSvg(realmiteFromSeed("m"), { size: 16, state, uid: "t" })).not.toContain("data-animate");
      expect(animatesAt(160, state)).toBe(true);
    }
    expect(animatesAt(24, "idle")).toBe(false);
    expect(animatesAt(24, "working")).toBe(true);
  });

  it("pauses with the rest of the app when it goes quiet", () => {
    expect(REALMITE_CSS).toContain(":root[data-quiet] .rmt *{animation-play-state:paused!important}");
  });
});
