import type { CSSProperties } from "react";

/** The app's one loading spinner — the G5 "Idling" orb from aicss.dev/components/orbs.
 *
 *  A wireframe globe of 40 dots (5 latitude rings × 8) that spins in bursts and breathes between
 *  them. There is no rotating element: every dot is projected onto the 2D stage at each of the nine
 *  poses, and the pose table ships as per-dot custom properties (`--g0x` … `--g8o`) that one shared
 *  keyframe walks. That keeps the whole thing on transform + opacity, and keeps the geometry here
 *  rather than duplicated across nine keyframe blocks.
 *
 *  Geometry is authored on a 28px stage and scaled by `--orb-k`; see SCALE for why `size` divides by
 *  22 and not 28. The dots paint in `currentColor`, so a caller tints the spinner by tinting its
 *  slot (`.tool-status` does exactly that). Styles: `.spinner` in styles.css. */

const STAGE_R = 8.5; // globe radius in stage px
const TILT = (14 * Math.PI) / 180; // the pole tips toward the viewer, so rings read as rings

/** The orb's ink spans 2·STAGE_R plus the 2px dot = 19 stage px, but a Hugeicons glyph only inks
 *  about 83% of its own box. Dividing `size` by 22 rather than by the 28px stage leaves the orb the
 *  same optical padding, so a `<Spinner size={n} />` reads at the weight of an `<Icon size={n} />`
 *  beside it rather than swimming in its box. */
const SCALE = 22;

const RINGS = [52, 26, 0, -26, -52]; // latitudes in degrees
const PER_RING = 8;

/** The nine poses `rl-orb-breathe` walks. A full turn split into four slow crawls and four bursts,
 *  with the globe shrinking to 0.8 and back over the same cycle — the burst is what makes it read as
 *  "thinking" rather than as a constant-rate spinner. */
const POSES: { scale: number; spin: number }[] = (() => {
  const SLOW = 0.4;
  const BURST = (Math.PI * 2 - SLOW * 4) / 4;
  const steps: [number, number][] = [
    [1.0, SLOW], [0.9, BURST], [0.9, SLOW], [0.8, BURST],
    [0.8, SLOW], [0.9, BURST], [0.9, SLOW], [1.0, BURST],
  ];
  const poses = [{ scale: 1, spin: 0 }];
  let spin = 0;
  for (const [scale, step] of steps) {
    spin += step;
    poses.push({ scale, spin });
  }
  return poses;
})();

/** Spin about the vertical axis, then tilt. Returns stage px plus the depth the fade keys on. */
function project(x: number, y: number, z: number, spin: number) {
  const x1 = x * Math.cos(spin) - z * Math.sin(spin);
  const z1 = x * Math.sin(spin) + z * Math.cos(spin);
  return {
    x: x1,
    y: y * Math.cos(TILT) - z1 * Math.sin(TILT),
    z: y * Math.sin(TILT) + z1 * Math.cos(TILT),
  };
}

/** Depth cue: dots on the far side dim to 0.12 and come back on a curve, which is what gives a flat
 *  ring of dots its roundness. */
function depthOpacity(z: number) {
  const t = Math.max(0, Math.min(1, (z / STAGE_R + 0.15) / 1.15));
  return 0.12 + 0.88 * t * t;
}

/** One `style` object per dot, carrying its nine projected poses. Constant, so it is built once. */
const DOTS: Record<string, string>[] = RINGS.flatMap((lat) => {
  const latRad = (lat * Math.PI) / 180;
  const y0 = Math.sin(latRad) * STAGE_R;
  const ringR = Math.cos(latRad) * STAGE_R;
  return Array.from({ length: PER_RING }, (_, j) => {
    const lon = (j / PER_RING) * Math.PI * 2;
    const style: Record<string, string> = {};
    POSES.forEach(({ scale, spin }, k) => {
      const p = project(Math.cos(lon) * ringR * scale, y0 * scale, Math.sin(lon) * ringR * scale, spin);
      style[`--g${k}x`] = `${p.x.toFixed(2)}px`;
      style[`--g${k}y`] = `${(-p.y).toFixed(2)}px`; // screen y grows downward
      style[`--g${k}o`] = depthOpacity(p.z).toFixed(3);
    });
    return style;
  });
});

/** Decorative by default, like `Icon`: every call site already names the state it is waiting on
 *  ("running" on the tool row, "Generating…" in the button), and a second announcement is noise. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <span className={"spinner" + (className ? ` ${className}` : "")} aria-hidden="true"
      style={{ width: size, height: size, "--orb-k": size / SCALE } as CSSProperties}>
      {DOTS.map((style, i) => <span key={i} className="spinner-dot" style={style as CSSProperties} />)}
    </span>
  );
}
