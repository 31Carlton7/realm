import { beforeAll, describe, expect, it } from "vitest";
import { officeIdFor, paletteFor, reconcileOffice, type OfficeAgent, type OfficeAgentSink, type OfficeCast } from "./bridge.js";
import { checkWorld, furnitureVocabulary, worldBounds } from "./world.js";
import { checkSprite, SPRITE_MAX_TILES, SPRITE_TILE } from "./sprite.js";
import { applyTheme, THEMES } from "./theme.js";
import type { OfficeLayout } from "./vendor/office/types.js";
import { DEFAULT_LAYOUT, installOfficeAssets, registerDrawnFurniture } from "./assets.js";

/** Records what the bridge told the office to do, in order. */
function sink() {
  const calls: string[] = [];
  const office: OfficeAgentSink = {
    addAgent: (id, palette) => calls.push(`add:${id}:${palette}`),
    removeAgent: (id) => calls.push(`remove:${id}`),
    setAgentActive: (id, active) => calls.push(`active:${id}:${active}`),
    setAgentTool: (id, tool) => calls.push(`tool:${id}:${tool}`),
    showPermissionBubble: (id) => calls.push(`bubble:${id}`),
    clearPermissionBubble: (id) => calls.push(`unbubble:${id}`),
  };
  return { office, calls };
}

const agent = (id: string, status: OfficeAgent["status"], tool: string | null = null): OfficeAgent =>
  ({ id, status, tool });

describe("office ids", () => {
  it("are stable for a session id, so a remount does not reseat everyone", () => {
    /* The mutant: a counter. The office is rebuilt whenever the pane reopens, and a counter would
       hand every agent a new chair and a new face on every visit. */
    expect(officeIdFor("01JABCDEF")).toBe(officeIdFor("01JABCDEF"));
    expect(officeIdFor("01JABCDEF")).not.toBe(officeIdFor("01JABCDEG"));
  });

  it("are positive, because the engine reserves negative ids for sub-agents", () => {
    for (const id of ["a", "01J", "", "zzzzzzzzzzzzzzzzzzzzzzzzzz"]) {
      expect(officeIdFor(id), id).toBeGreaterThan(0);
    }
  });

  it("give a session the same face every time, and none at all with no characters loaded", () => {
    expect(paletteFor("s1", 6)).toBe(paletteFor("s1", 6));
    expect(paletteFor("s1", 6)).toBeLessThan(6);
    expect(paletteFor("s1", 0)).toBe(0);
  });
});

describe("reconcileOffice", () => {
  it("adds a character for a new agent and takes it away when the session goes", () => {
    const { office, calls } = sink();
    const one = reconcileOffice(office, new Map(), [agent("a", "running")], 6);
    expect(calls.some((c) => c.startsWith("add:"))).toBe(true);
    calls.length = 0;
    reconcileOffice(office, one, [], 6);
    expect(calls).toEqual([`remove:${officeIdFor("a")}`]);
  });

  it("writes only what changed — the FSM has its own timers and being retold defeats them", () => {
    /* The mutant: set active/tool/bubble every frame. `setAgentTool` is read by the character FSM to
       decide when to get up, and being told the same thing sixty times a second is not the same as
       being told it once. */
    const { office, calls } = sink();
    const first = reconcileOffice(office, new Map(), [agent("a", "running", "Bash")], 6);
    calls.length = 0;
    const second = reconcileOffice(office, first, [agent("a", "running", "Bash")], 6);
    expect(calls).toEqual([]);
    calls.length = 0;
    reconcileOffice(office, second, [agent("a", "running", "Edit")], 6);
    expect(calls).toEqual([`tool:${officeIdFor("a")}:Edit`]);
  });

  it("keeps a blocked agent at its desk, with the bubble and without the typing", () => {
    /* The judgment this file exists for. An inactive character stands up and wanders, which is what
       the END of a turn looks like — and a blocked agent has not finished anything. It is mid-turn
       holding a question for you. The mutant is `active = status === "running"`, which sends every
       agent that asks you something for a walk around the office. */
    const { office, calls } = sink();
    const id = officeIdFor("a");
    reconcileOffice(office, new Map(), [agent("a", "waiting_permission", "Bash")], 6);
    expect(calls).toContain(`active:${id}:true`);
    expect(calls).toContain(`bubble:${id}`);
    // …and not typing: the tool is what animates the hands, and it is not doing anything.
    expect(calls).toContain(`tool:${id}:null`);
  });

  it("sends a failed agent away from its desk, because that turn really is over", () => {
    const { office, calls } = sink();
    reconcileOffice(office, new Map(), [agent("a", "error")], 6);
    expect(calls).toContain(`active:${officeIdFor("a")}:false`);
  });

  it("raises and clears the bubble on the transitions, not on every frame", () => {
    const { office, calls } = sink();
    const id = officeIdFor("a");
    const blocked = reconcileOffice(office, new Map(), [agent("a", "waiting_permission")], 6);
    calls.length = 0;
    const still = reconcileOffice(office, blocked, [agent("a", "waiting_permission")], 6);
    expect(calls).toEqual([]);
    reconcileOffice(office, still, [agent("a", "running", "Bash")], 6);
    expect(calls).toContain(`unbubble:${id}`);
  });

  it("keeps each agent's own chair when a neighbour leaves", () => {
    const { office } = sink();
    const three = reconcileOffice(office, new Map(), ["a", "b", "c"].map((i) => agent(i, "running")), 6);
    const two = reconcileOffice(office, three, [agent("a", "running"), agent("c", "running")], 6);
    expect(two.get("c")!.officeId).toBe(three.get("c")!.officeId);
  });
});

describe("checkWorld", () => {
  /* With no assets installed the catalog is EMPTY, and an empty catalog refuses every furniture type
     — including the real ones. A "rejects nonsense" test would then pass without the lookup working
     at all, so the assets go in first and the positive case below is what keeps it honest. */
  beforeAll(() => installOfficeAssets());

  const room = (over: Record<string, unknown> = {}) => ({
    version: 1, cols: 6, rows: 5, tiles: Array(30).fill(1), furniture: [], ...over,
  });

  it("offers a vocabulary, and accepts every piece in it", () => {
    const vocab = furnitureVocabulary();
    expect(vocab.length).toBeGreaterThan(0);
    const ids = vocab.flatMap((g) => g.ids);
    expect(ids.length).toBeGreaterThan(10);
    for (const type of ids) {
      const check = checkWorld(room({ furniture: [{ type, col: 1, row: 1 }] }));
      expect(check.ok, `${type} is in the vocabulary but was refused`).toBe(true);
    }
  });

  it("accepts a plain room", () => {
    expect(checkWorld(room()).ok).toBe(true);
  });

  it("refuses a tile array that is not cols × rows", () => {
    /* The one that is silent rather than loud: the renderer reads `tiles[row * cols + col]`, so a
       short array is a room with `undefined` in it and no exception — a world with holes, drawn. */
    const bad = checkWorld(room({ tiles: Array(12).fill(1) }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems.join(" ")).toContain("30");
  });

  it("refuses tile values the renderer cannot draw", () => {
    const bad = checkWorld(room({ tiles: [...Array(29).fill(1), 77] }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems.join(" ")).toContain("77");
  });

  it("refuses furniture that does not exist, and names it", () => {
    /* A model will invent `ESPRESSO_MACHINE`, and the engine looks furniture up without checking. */
    const bad = checkWorld(room({ furniture: [{ type: "ESPRESSO_MACHINE", col: 1, row: 1 }] }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems.join(" ")).toContain("ESPRESSO_MACHINE");
  });

  it("collects every problem rather than stopping at the first", () => {
    /* A model handed all of its mistakes fixes them in one turn; handed one at a time, in four. */
    const bad = checkWorld({ cols: 2, rows: 5, tiles: [1, 2], furniture: "no" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems.length).toBeGreaterThan(2);
  });

  it("refuses something that is not a world at all, rather than throwing", () => {
    for (const junk of [null, 42, "a room", []]) expect(checkWorld(junk).ok, String(junk)).toBe(false);
  });

  it("does not judge the room — an odd world the user asked for still renders", () => {
    /* No chairs, no desks, a wall down the middle. All of it draws, so all of it is allowed; this
       function's brief is "will the renderer survive it", not "is it a sensible office". */
    expect(checkWorld(room({ tiles: Array(30).fill(0) })).ok).toBe(true);
  });
});

describe("checkSprite", () => {
  const drawn = (over: Record<string, unknown> = {}) => ({
    name: "Arcade cabinet",
    palette: { a: "#1a1a2e", b: "#e94560" },
    pixels: ["aaaa", "abba", "abba", "aaaa"],
    ...over,
  });

  it("turns a palette and rows of characters into a sprite grid", () => {
    const c = checkSprite(drawn());
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.name).toBe("Arcade cabinet");
    expect(c.sprite[1]).toEqual(["#1a1a2e", "#e94560", "#e94560", "#1a1a2e"]);
    expect(c.footprintW).toBe(1);
    expect(c.footprintH).toBe(1);
  });

  it("reads `.` as transparent, which is what lets a shape have corners", () => {
    const c = checkSprite(drawn({ pixels: [".aa.", "abba", "abba", ".aa."] }));
    expect(c.ok && c.sprite[0]).toEqual(["", "#1a1a2e", "#1a1a2e", ""]);
  });

  it("refuses a ragged drawing — the rows ARE the image", () => {
    const c = checkSprite(drawn({ pixels: ["aaaa", "ab", "aaaa"] }));
    expect(c.ok).toBe(false);
    expect(!c.ok && c.problems.join(" ")).toMatch(/4 characters/);
  });

  it("refuses a character the palette never defined", () => {
    /* The model's most likely slip: drawing with a key it forgot to name. Left alone this is an
       `undefined` colour handed to `fillStyle`, which paints black and looks deliberate. */
    const c = checkSprite(drawn({ pixels: ["aaaa", "azza", "azza", "aaaa"] }));
    expect(c.ok).toBe(false);
    expect(!c.ok && c.problems.join(" ")).toContain('"z"');
  });

  it("refuses a palette entry that is not a hex colour", () => {
    const c = checkSprite(drawn({ palette: { a: "red", b: "#e94560" } }));
    expect(c.ok).toBe(false);
    expect(!c.ok && c.problems.join(" ")).toMatch(/palette\.a/);
  });

  it("refuses a drawing bigger than furniture is allowed to be", () => {
    const wide = "a".repeat(SPRITE_TILE * SPRITE_MAX_TILES + 1);
    const c = checkSprite(drawn({ pixels: [wide, wide] }));
    expect(c.ok).toBe(false);
    expect(!c.ok && c.problems.join(" ")).toMatch(/at most/);
  });

  it("refuses a drawing with nothing in it", () => {
    /* Valid by every other rule and invisible on the floor. */
    const c = checkSprite(drawn({ pixels: ["....", "....", "....", "...."] }));
    expect(c.ok).toBe(false);
    expect(!c.ok && c.problems.join(" ")).toMatch(/transparent/);
  });

  it("measures the footprint from the pixels rather than believing a claim about it", () => {
    /* A model that says two tiles and draws three puts a chair through a wall, and only one of those
       two numbers is evidence. */
    const row = "a".repeat(SPRITE_TILE * 2 + 3);
    const c = checkSprite(drawn({ pixels: Array(SPRITE_TILE + 1).fill(row), footprintW: 1, footprintH: 1 }));
    expect(c.ok && c.footprintW).toBe(3);
    expect(c.ok && c.footprintH).toBe(2);
  });
});

describe("registerDrawnFurniture", () => {
  it("makes a drawn piece placeable, under a namespaced id", () => {
    installOfficeAssets();
    const before = furnitureVocabulary().flatMap((g) => g.ids);
    const id = registerDrawnFurniture({
      id: "arcade cabinet", label: "Arcade cabinet",
      sprite: [["#111111", "#222222"], ["#111111", "#222222"]], footprintW: 1, footprintH: 1,
    });
    /* Namespaced, because a drawn "desk" that overwrote DESK would silently change every office
       that ever placed one. */
    expect(id).toBe("DRAWN_ARCADE_CABINET");
    expect(before).not.toContain(id);
    expect(furnitureVocabulary().flatMap((g) => g.ids)).toContain(id);
    // …and a world may now place it, which is the whole point of registering.
    expect(checkWorld({ version: 1, cols: 4, rows: 4, tiles: Array(16).fill(1), furniture: [{ type: id, col: 1, row: 1 }] }).ok).toBe(true);
  });
});

describe("worldBounds", () => {
  /** A 6×6 grid whose room is a 3×2 patch in the bottom-right — the shape of a hand-authored
   *  layout, where the declared grid is much bigger than the room in it. */
  const padded: OfficeLayout = {
    version: 1, cols: 6, rows: 6, furniture: [],
    tiles: [
      255, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 255, 255,
      255, 255,   1,   1,   1, 255,
      255, 255,   1,   1,   1, 255,
    ],
  };

  it("measures the room, not the grid it was declared with", () => {
    /* The bug this exists for: the office Realm ships declares 21×22 and fills eleven rows, so
       fitting the declared grid halved the zoom AND centred the empty half along with the room.
       The mutant is `{ cols: layout.cols, rows: layout.rows }`. */
    const b = worldBounds(padded);
    expect([b.minCol, b.maxCol, b.minRow, b.maxRow]).toEqual([2, 4, 4, 5]);
    expect([b.cols, b.rows]).toEqual([3, 2]);
  });

  it("falls back to the declared grid for a world with no floor at all", () => {
    const b = worldBounds({ ...padded, tiles: Array(36).fill(255) });
    expect([b.cols, b.rows]).toEqual([6, 6]);
  });

  it("is the whole grid when the room fills it, which is the generated case", () => {
    const b = worldBounds({ ...padded, tiles: Array(36).fill(1) });
    expect([b.minCol, b.minRow, b.cols, b.rows]).toEqual([0, 0, 6, 6]);
  });

  it("agrees with a direct scan of the office Realm actually ships", () => {
    /* The layout everybody sees first, measured rather than assumed. This used to assert the shipped
       office was much SMALLER than it declared — which was true of the upstream file it replaced,
       where half the grid was padding. That was a property of that file, not an invariant, and
       keeping it would now mean asserting the default office is badly authored. */
    const b = worldBounds(DEFAULT_LAYOUT);
    const occupied = DEFAULT_LAYOUT.tiles
      .map((t, i) => ({ t, col: i % DEFAULT_LAYOUT.cols, row: Math.floor(i / DEFAULT_LAYOUT.cols) }))
      .filter((x) => x.t !== 255);
    expect(b.minCol).toBe(Math.min(...occupied.map((x) => x.col)));
    expect(b.maxRow).toBe(Math.max(...occupied.map((x) => x.row)));
  });

  it("the shipped office wastes no grid on padding, so fitting it fills the pane", () => {
    /* The other half of the sizing fix. `worldBounds` stops a padded layout rendering at half size;
       this stops the shipped one being padded in the first place. */
    const b = worldBounds(DEFAULT_LAYOUT);
    expect(b.cols).toBe(DEFAULT_LAYOUT.cols);
    expect(b.rows).toBe(DEFAULT_LAYOUT.rows);
  });

  it("the shipped office is big enough for a full fan-out", () => {
    /* Twelve agents is what the launcher will start, and a room that seats six puts half of them on
       the floor. Counted as chairs rather than trusted to the generator's own message. */
    const chairs = DEFAULT_LAYOUT.furniture.filter((f) => /CHAIR|SOFA|BENCH/.test(f.type));
    expect(chairs.length).toBeGreaterThanOrEqual(12);
    expect(DEFAULT_LAYOUT.cols * DEFAULT_LAYOUT.rows).toBeGreaterThan(21 * 22);
  });
});

describe("paint", () => {
  /* The floor sprites are greyscale masters — floor 1 is one flat #A7A7A7 — so "no theme" does not
     render a neutral office, it renders a white one. That is what "a map room of the DC area" came
     back as, and these pin the two places it could happen again. */
  it("every shipped theme actually tints, rather than leaving the masters grey", () => {
    for (const t of THEMES) {
      const neutral = t.floor.h === 0 && t.floor.s === 0 && t.floor.b === 0 && t.floor.c === 0;
      expect(neutral, `${t.name} makes no change to a greyscale master`).toBe(false);
      /* `adjust` mode SHIFTS a hue the pixel already has, and a grey pixel has none. Only colorize
         can put a colour on these sprites at all. */
      expect(t.floor.colorize, `${t.name}'s floor cannot tint a greyscale master without colorize`).toBe(true);
      expect(t.wall.colorize, `${t.name}'s wall cannot tint a greyscale master without colorize`).toBe(true);
    }
  });

  it("the office Realm opens on is painted, not left grey", () => {
    const colours = DEFAULT_LAYOUT.tileColors;
    expect(colours, "the default office ships no tileColors and would render white").toBeDefined();
    const painted = (colours ?? []).filter((c) => c && c.colorize);
    expect(painted.length).toBeGreaterThan(DEFAULT_LAYOUT.tiles.length / 2);
    // …and its rooms differ, which is what makes it read as rooms rather than one hall.
    expect(new Set((colours ?? []).filter(Boolean).map((c) => c!.h)).size).toBeGreaterThan(2);
  });

  it("applyTheme paints every non-void tile and leaves the holes alone", () => {
    const layout = { version: 1 as const, cols: 3, rows: 2, furniture: [], tiles: [1, 0, 255, 1, 1, 255] } as OfficeLayout;
    const painted = applyTheme(layout, THEMES[1]!);
    expect(painted.tileColors!.map((c) => (c === null ? "-" : c.h))).toEqual([230, 232, "-", 230, 230, "-"]);
  });
});
