import { useEffect, useMemo } from "react";
import { drawMap } from "./vendor/lens-samasante";
import type { LensShape } from "./lens";
import { useLook } from "./use-look";

/**
 * The lenses every glass control shares, drawn once while glass is on. Each is a filter in the
 * element's own bounding box (`objectBoundingBox`), so one map serves every box of roughly that shape:
 * a picker's panel, a segment or a switch's knob, whatever its size. The prompter keeps a lens drawn
 * for its own size (PrompterGlass), because it grows from one line to many and a stretched map would
 * thicken its rim as it grew.
 *
 * `scale` is the bend as a share of the box: a small control needs a bigger share to bend anything
 * a person can see.
 */
export const SHARED_LENSES = {
  panel: { shape: { width: 620, height: 480, radius: 12 }, size: 256, scale: 0.04 },
  pill: { shape: { width: 64, height: 24, radius: 8 }, size: 128, scale: 0.12 },
  bead: { shape: { width: 16, height: 16, radius: 8 }, size: 64, scale: 0.25 },
} satisfies Record<string, { shape: LensShape; size: number; scale: number }>;

export type SharedLens = keyof typeof SHARED_LENSES;
export const sharedLensId = (name: SharedLens) => `rl-glass-${name}`;

export function GlassDefs() {
  const maps = useMemo(() => Object.entries(SHARED_LENSES).map(([name, l]) => ({ name: name as SharedLens, map: drawMap(l.shape, l.size), scale: l.scale })), []);
  return (
    <svg className="glass-defs" width={0} height={0} aria-hidden="true" focusable="false">
      {maps.map(({ name, map, scale }) => map && (
        <filter key={name} id={sharedLensId(name)} x={0} y={0} width={1} height={1}
          filterUnits="objectBoundingBox" primitiveUnits="objectBoundingBox" colorInterpolationFilters="sRGB">
          <feImage href={map} x={0} y={0} width={1} height={1} preserveAspectRatio="none" result="map" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale={scale} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      ))}
    </svg>
  );
}

/** Every glass control keys off one attribute on the root (styles.css, "Glass"), set only while glass
 *  is both chosen and drawable, so a fallback puts the whole app back to plain at once. */
export function GlassRoot() {
  const glass = useLook() === "glass";
  useEffect(() => {
    document.documentElement.toggleAttribute("data-glass", glass);
    return () => document.documentElement.removeAttribute("data-glass");
  }, [glass]);
  return glass ? <GlassDefs /> : null;
}
