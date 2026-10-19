import { Icon, type IconName } from "@realm/ui";
import { useEffect, useRef, useState, type AnimationEvent } from "react";
import { ICON3D_FILES } from "./icon3d-files";

/**
 * The team's 3D icons, and the glyph each one stands in for. A picture is drawn where the set has
 * one (`assets/icons3d`, made by `scripts/icons3d.mjs`); without it the glyph is drawn in the same
 * box, so a row never moves when its picture arrives.
 */
export const ICON3D_GLYPH = {
  review: "review",
  overview: "team",
  records: "records",
  policies: "shield",
  vault: "padlock",
  activity: "activity",
  "add-teammate": "add",
  "custom-teammate": "add",
  note: "note",
  link: "link",
  contact: "user",
  briefcase: "briefcase",
  flag: "flag",
  bug: "alert",
  browser: "browser",
} as const satisfies Record<string, IconName>;
export type Icon3DName = keyof typeof ICON3D_GLYPH;

/** The rungs a 3D icon is drawn at: a row of the team's column, a card, an empty state. A picture
 *  is a smudge below 20, which is why the sidebar's 12px rows keep their glyphs. */
export const ICON3D_SIZES = [20, 32, 64] as const;
export type Icon3DSize = (typeof ICON3D_SIZES)[number];
/** Each picture is shipped at 1x, 2x and 3x of its rung. */
export const ICON3D_DENSITIES = [1, 2, 3] as const;

/** The stand-in glyph for each rung: the size the glyph had in that place before. 64's 24 is
 *  off-ladder: it is the empty team's picture, as it drew before it had one. */
const GLYPH_SIZE: Record<Icon3DSize, number> = { 20: 16, 32: 20, 64: 24 };

/** The picture's files for a rung, or null while any density of it is missing. */
export function icon3dSources(name: Icon3DName, size: Icon3DSize): { src: string; srcSet: string } | null {
  const urls = ICON3D_DENSITIES.map((d) => ICON3D_FILES[`../assets/icons3d/${name}-${size * d}.webp`]);
  if (urls.some((u) => !u)) return null;
  return { src: urls[0]!, srcSet: urls.map((u, i) => `${u} ${ICON3D_DENSITIES[i]}x`).join(", ") };
}

/**
 * A 3D icon on its rung. It leans and lifts under the pointer of the control it is in, is pushed down
 * by a press, and settles with one small bounce when its row becomes the chosen one — not when it is
 * drawn already chosen, so opening a page does not set its column bouncing. All of it is the
 * stylesheet's, so Reduce motion stills it (styles.css, 3D icons). Decorative: the row's own words
 * name it.
 */
export function Icon3D({ name, size, selected = false, className }: { name: Icon3DName; size: Icon3DSize; selected?: boolean; className?: string }) {
  const [settling, setSettling] = useState(false);
  const wasSelected = useRef(selected);
  useEffect(() => {
    if (selected && !wasSelected.current) setSettling(true);
    if (!selected) setSettling(false);
    wasSelected.current = selected;
  }, [selected]);
  const sources = icon3dSources(name, size);
  return (
    <span className={className ? `i3d ${className}` : "i3d"} data-icon={name} data-size={size} data-art={sources ? "" : undefined} data-settle={settling || undefined}
      aria-hidden="true" onAnimationEnd={(e: AnimationEvent) => { if (e.animationName === "i3d-settle") setSettling(false); }}>
      {sources
        ? <img className="i3d-art" src={sources.src} srcSet={sources.srcSet} width={size} height={size} alt="" draggable={false} decoding="async" />
        : <Icon name={ICON3D_GLYPH[name]} size={GLYPH_SIZE[size]} className="i3d-art i3d-glyph" />}
    </span>
  );
}
