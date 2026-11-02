import { useId } from "react";
import type { TeammateIcon as TeammateIconSpec } from "@realm/contracts";
import { BADGE_OKLCH, bodyOklch, bothFaces, EYE_OKLCH } from "./palette";
import { SHAPE_GEO } from "./shapes";

/** The eyes in the 64-unit square, laid on the pixel grid of the size they are drawn at.
 *
 *  Each eye is a short stroke with round caps, leaning right. At row size an eye is two pixels wide
 *  and four tall, and a stroke that straddles a pixel boundary greys into a smudge, so every edge that
 *  can land on a whole pixel does: the width is a whole number of pixels, the stroke's sides and its
 *  cap tops fall on pixel edges, and the lean is cut back until it shifts the stroke under a pixel. */
export function eyeStrokes(face: [number, number], size: number): { d: string; width: number } {
  const s = size / 64;
  const w = Math.max(2, Math.round(5.5 * s));
  const len = Math.max(2, Math.round(8 * s));
  const gap = Math.max(w + 2, Math.round(12.5 * s));
  const lean = ((size < 28 ? 8 : 15) * Math.PI) / 180;
  const total = len + w;
  const x0 = Math.round(face[0] * s - gap / 2 - w / 2) + w / 2;
  const y0 = Math.round(face[1] * s - total / 2) + total / 2;
  const dx = (Math.sin(lean) * len) / 2, dy = (Math.cos(lean) * len) / 2;
  const n = (v: number) => Number((v / s).toFixed(3));
  const d = [x0, x0 + gap].map((x) => `M${n(x - dx)} ${n(y0 + dy)}L${n(x + dx)} ${n(y0 - dy)}`).join("");
  return { d, width: n(w) };
}

/** The Lead's star, on the bottom-right corner and a little past it, cut into the body with an even gap
 *  round its own outline so it reads at row size without an outline of its own. It is sized in pixels
 *  rather than as a share of the square: a third of a 64px icon is a badge, a third of a 16px one is a
 *  speck, so the small sizes take relatively more — and stand further past the corner, so the star never
 *  reaches the eyes. Its points are softened by a round-joined stroke of its own fill. */
export function leadStar(size: number): { d: string; soften: number; cut: number } {
  const s = size / 64;
  const r = Math.max(3.6, size * 0.17) / s;
  const gap = Math.max(1, size * 0.035) / s;
  const inset = size < 28 ? 0.72 : 0.9;
  const cx = 64 - r * inset, cy = 64 - r * inset;
  const pts = Array.from({ length: 10 }, (_, i) => {
    const radius = (i % 2 ? 0.5 : 0.9) * r, a = ((-90 + i * 36) * Math.PI) / 180;
    return `${(cx + radius * Math.cos(a)).toFixed(2)} ${(cy + radius * Math.sin(a)).toFixed(2)}`;
  });
  const soften = r * 0.2;
  return { d: `M${pts.join("L")}Z`, soften, cut: soften + gap * 2 };
}

/**
 * A teammate's mark: one flat shape in its colour and two short eye strokes. Nothing else — no
 * outline, gradient, shading, motion or mood. It says who, never how it is doing; state is the dot
 * beside it.
 *
 * `size` is the rendered square in px (16 in a row, 24 in a head, 64 in the maker), and the eyes are
 * laid on that size's pixel grid. Give it a `title` where nothing beside it names the teammate; leave
 * it out beside the name, where it is decoration.
 */
export function TeammateIcon({ icon, size, lead = false, title, className }: {
  icon: TeammateIconSpec;
  size: number;
  lead?: boolean;
  title?: string;
  className?: string;
}) {
  const mask = `tm${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const geo = SHAPE_GEO[icon.shape];
  const eyes = eyeStrokes(geo.face, size);
  const star = leadStar(size);
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" role={title ? "img" : undefined}
      aria-label={title} aria-hidden={title ? undefined : true} data-shape={icon.shape} data-color={icon.color}
      style={{ display: "block", flex: "none", overflow: "visible" }}>
      {lead && (
        <mask id={mask} maskUnits="userSpaceOnUse" x="-8" y="-8" width="80" height="80">
          <rect x="-8" y="-8" width="80" height="80" fill="#fff" />
          <path d={star.d} fill="#000" stroke="#000" strokeWidth={star.cut} strokeLinejoin="round" />
        </mask>
      )}
      <g mask={lead ? `url(#${mask})` : undefined}>
        <g style={{ fill: bothFaces((face) => bodyOklch(icon.color, face)) }}>
          {geo.prims.map((p, i) => ("circle" in p
            ? <circle key={i} cx={p.circle[0]} cy={p.circle[1]} r={p.circle[2]} />
            : <path key={i} d={p.d} />))}
        </g>
        <path d={eyes.d} fill="none" strokeWidth={eyes.width} strokeLinecap="round"
          style={{ stroke: bothFaces((face) => EYE_OKLCH[face]) }} />
      </g>
      {lead && (
        <path d={star.d} strokeLinejoin="round" strokeWidth={star.soften}
          style={{ fill: bothFaces((face) => BADGE_OKLCH[face]), stroke: bothFaces((face) => BADGE_OKLCH[face]) }} />
      )}
    </svg>
  );
}
