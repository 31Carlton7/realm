/**
 * Palette diversity utilities for agent character assignment.
 *
 * Pure functions with no DOM/sprite dependencies — safe for use in both
 * browser (webview) and Node.js (server) environments.
 */

export interface PalettePick {
  palette: number;
  hueShift: number;
}

const HUE_SHIFT_MIN_DEG = 45;
const HUE_SHIFT_RANGE_DEG = 271;

/**
 * Pick a diverse palette based on current palette distribution.
 * First N agents each get a unique skin (where N = paletteCount).
 * Beyond N, skins repeat in balanced rounds with a random hue shift (≥45°).
 *
 * @param paletteCount - Total number of available palettes (e.g., 6)
 * @param paletteCounts - Array of counts per palette (length must equal paletteCount)
 * @returns Selected palette index and hue shift in degrees
 */
export function pickDiversePalette(paletteCount: number, paletteCounts: number[]): PalettePick {
  if (paletteCounts.length !== paletteCount) {
    throw new Error(
      `paletteCounts length (${paletteCounts.length}) must equal paletteCount (${paletteCount})`,
    );
  }

  const minCount = Math.min(...paletteCounts);
  const available: number[] = [];
  for (let i = 0; i < paletteCount; i++) {
    if (paletteCounts[i] === minCount) available.push(i);
  }
  const palette = available[Math.floor(Math.random() * available.length)];

  // First round (minCount === 0): no hue shift. Subsequent rounds: random ≥45°.
  let hueShift = 0;
  if (minCount > 0) {
    hueShift = HUE_SHIFT_MIN_DEG + Math.floor(Math.random() * HUE_SHIFT_RANGE_DEG);
  }

  return { palette, hueShift };
}
