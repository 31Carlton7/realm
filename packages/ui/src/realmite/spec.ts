import {
  ACCESSORIES, BODIES, EYES, MOUTHS, PALETTES, PATTERNS,
  type AccessoryId, type BodyId, type EyesId, type MouthId, type PaletteId, type PatternId,
} from "./parts";

/** A Realmite as it is stored: plain JSON, every part an id. The seed rides along because it is what
 *  the creature was rolled from and what staggers its blink, but the parts are written out in full —
 *  a spec read back after the generator has been retuned is still the creature the person chose. */
export type RealmiteSpec = {
  v: 1;
  seed: string;
  body: BodyId;
  palette: PaletteId;
  eyes: EyesId;
  mouth: MouthId;
  accessory: AccessoryId;
  pattern: PatternId;
  cheeks: boolean;
};

export type RealmitePatch = Partial<Omit<RealmiteSpec, "v">>;

/** What a Realmite is doing, which is all its face ever reports: these are the run's states, never a
 *  mood (design.md, Agent sessions). `sleeping` covers done and idle-for-the-night alike. */
export const REALMITE_STATES = ["idle", "working", "needs-you", "sleeping"] as const;
export type RealmiteState = (typeof REALMITE_STATES)[number];

export const PART_IDS = {
  body: Object.keys(BODIES) as BodyId[],
  palette: Object.keys(PALETTES) as PaletteId[],
  eyes: Object.keys(EYES) as EyesId[],
  mouth: Object.keys(MOUTHS) as MouthId[],
  accessory: Object.keys(ACCESSORIES) as AccessoryId[],
  pattern: Object.keys(PATTERNS) as PatternId[],
};

/** FNV-1a, 32-bit: the seed's text to a number. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 — the same pairing DiceBear uses, small and good enough to pick parts with. */
function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weighted<T extends string>(rand: () => number, weights: Partial<Record<T, number>>): T {
  const entries = Object.entries(weights).filter(([, w]) => (w as number) > 0) as [T, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r < 0) return k;
  }
  return entries[entries.length - 1]![0];
}

/* The generator rolls only from combinations that were looked at and kept. A person can still put
   any part on any body in the maker — every pairing draws — but a shuffle never offers one of these:

   - A drop comes to a point, so nothing sits on top of it but a sprout or a bobble.
   - Stripes run across the crown, so they are not rolled under a beanie or a cap that covers it.
   - A face plate is a lighter field behind the eyes; a single eye on it reads as a porthole.
   - Cheeks beside one eye sit too far from it and read as two more features.
   - The facet is the mark's wall, and only the cube has walls; on a round body it splits the face in two. */
const ACCESSORY_WEIGHTS: Record<AccessoryId, number> = {
  none: 5, sprout: 2, bobble: 2, beanie: 2, cap: 2, horns: 2, headphones: 1.5, "cat-ears": 2, "bear-ears": 2,
};

export function realmiteFromSeed(seed: string): RealmiteSpec {
  const rand = mulberry32(hashSeed(seed));
  const body = weighted<BodyId>(rand, { cube: 3, squircle: 3, gumdrop: 3, bean: 2, mochi: 2, egg: 2, drop: 1.5 });
  const palette = PART_IDS.palette[Math.floor(rand() * PART_IDS.palette.length)]!;
  const eyes = weighted<EyesId>(rand, { dot: 3, bean: 3, shine: 3, lidded: 1.5, cyclops: 1 });
  const mouth = weighted<MouthId>(rand, { none: 1.5, smile: 3, cat: 2, open: 1.5, flat: 1.5, fang: 1.5 });
  const accessory = weighted<AccessoryId>(rand, body === "drop"
    ? { none: 4, sprout: 2, bobble: 2 }
    : ACCESSORY_WEIGHTS);
  const covered = accessory === "beanie" || accessory === "cap";
  const pattern = weighted<PatternId>(rand, {
    none: 4, belly: 2, facet: body === "cube" ? 3 : 0, spots: 1.5, stripes: covered ? 0 : 1.5, faceplate: eyes === "cyclops" ? 0 : 1,
  });
  const cheeks = eyes !== "cyclops" && rand() < 0.4;
  return { v: 1, seed, body, palette, eyes, mouth, accessory, pattern, cheeks };
}

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

/** A new spec with the patch applied. Pure: the input is never touched, and a value that names no
 *  part is ignored rather than stored, so a spec is always drawable. Changing the seed alone does not
 *  reroll the parts — that is `realmiteFromSeed`, which the maker's shuffle calls. */
export function customize(spec: RealmiteSpec, patch: RealmitePatch): RealmiteSpec {
  const next: RealmiteSpec = { ...spec };
  if (typeof patch.seed === "string" && patch.seed) next.seed = patch.seed;
  if (isOneOf(PART_IDS.body, patch.body)) next.body = patch.body;
  if (isOneOf(PART_IDS.palette, patch.palette)) next.palette = patch.palette;
  if (isOneOf(PART_IDS.eyes, patch.eyes)) next.eyes = patch.eyes;
  if (isOneOf(PART_IDS.mouth, patch.mouth)) next.mouth = patch.mouth;
  if (isOneOf(PART_IDS.accessory, patch.accessory)) next.accessory = patch.accessory;
  if (isOneOf(PART_IDS.pattern, patch.pattern)) next.pattern = patch.pattern;
  if (typeof patch.cheeks === "boolean") next.cheeks = patch.cheeks;
  return next;
}

/** A spec read back from storage. Whatever part is missing or unknown — a row written by a later
 *  version, or hand-edited — comes from the seed rather than failing the whole creature, and with no
 *  usable seed the fallback is the caller's own (the role's id, say), so the same row always draws
 *  the same Realmite. */
export function parseRealmiteSpec(value: unknown, fallbackSeed: string): RealmiteSpec {
  const raw = (typeof value === "string" ? safeJson(value) : value) as Record<string, unknown> | null;
  const seed = raw && typeof raw.seed === "string" && raw.seed ? raw.seed : fallbackSeed;
  const base = realmiteFromSeed(seed);
  if (!raw || typeof raw !== "object") return base;
  return customize(base, raw as RealmitePatch);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A fresh seed for the maker's shuffle. Not derived from anything: a shuffle is a new creature. */
export function randomSeed(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
