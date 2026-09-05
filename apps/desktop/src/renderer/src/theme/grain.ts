import type { CSSProperties } from "react";

/** Decorative wash geometry, drawn once per launch.
 *
 *  The user asked for randomised colour. Free randomisation is not available here: every hue the app
 *  paints is a token with a meaning (--red is failure, --green is done), and a decorative field that
 *  landed on one by chance would say something. So the only degree of freedom is an offset from the
 *  theme's OWN accent, held inside an arc narrow enough that the result still reads as the palette
 *  the user chose. Lightness and chroma are NOT randomised — they are pinned in tokens.css to the
 *  band that leaves every ink tier above its contrast floor, and are the reason this is safe to ship
 *  on all seventeen faces.
 *
 *  Seeded once per launch, keyed by surface: two surfaces on screen together should not be the same
 *  picture, and one surface must not repaint itself on every React render. A launch is also the
 *  longest window over which "stable while it is on screen" is trivially true — a sheet that is
 *  closed and reopened comes back the same, which a per-open seed would not give. */

/** The arc, in degrees either side of the accent. Wide enough to read as a choice, narrow enough
 *  that no offset reaches the semantic hues on any palette. */
const ARC = 40;

/** The wash is anchored in the top band, never below the midline: the app's shadow language puts the
 *  light source above, and a glow rising from a bottom corner reads as a rendering fault. */
const ORIGIN = { x: [12, 88], y: [-12, 22] } as const;
const SPREAD = [72, 108] as const;

const LAUNCH_SEED = (Math.random() * 0xffffffff) >>> 0;

function hash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Successive independent draws from one key, each in 0..1. */
const draw = (key: string, n: number): number => hash(`${key}#${n}`) / 0x100000000;
const between = (t: number, [lo, hi]: readonly [number, number]): number => lo + t * (hi - lo);

/** The custom properties styles.css reads. Exported as a pure function of (surface, seed) so a test
 *  can pin the bounds without stubbing Math.random. */
export function grainVars(surface: string, seed: number = LAUNCH_SEED): CSSProperties {
  const key = `${seed}:${surface}`;
  return {
    // A bare number, not an angle: inside oklch(from ...) the origin's `h` component IS a number,
    // and calc() will not add a <angle> to it.
    "--grain-hue": `${Math.round(between(draw(key, 0), [-ARC, ARC]))}`,
    "--grain-x": `${Math.round(between(draw(key, 1), ORIGIN.x))}%`,
    "--grain-y": `${Math.round(between(draw(key, 2), ORIGIN.y))}%`,
    "--grain-spread": `${Math.round(between(draw(key, 3), SPREAD))}%`,
  } as CSSProperties;
}
