import { useEffect } from "react";
import { fitControls } from "./fitted-lens";
import { useLook } from "./use-look";

/**
 * The pressed controls that wear glass, each fitted with a lens for its own box (fitted-lens.ts): the
 * selected segment of a segmented control (the Documents Rich/Source toggle and the model picker's
 * among them) and a switch's knob. One map stretched over every segment thickened the rim on a wide
 * one and thinned it on a narrow one, so each size gets its own, shared by every box of that size.
 */
export const GLASS_CONTROLS = [
  { selector: `.documents-modes button[aria-pressed="true"], .seg-opt[data-selected], .settings-tabs > .settings-tab[data-selected], .mp-seg-opt[aria-pressed="true"]` },
  { selector: ".switch", pseudo: "::after" },
];

/** Every glass control keys off one attribute on the root (styles.css, "Glass"), set only while glass
 *  is both chosen and drawable, so a fallback puts the whole app back to plain at once. */
export function GlassRoot() {
  const glass = useLook() === "glass";
  useEffect(() => {
    document.documentElement.toggleAttribute("data-glass", glass);
    if (!glass) return () => document.documentElement.removeAttribute("data-glass");
    const stop = fitControls(GLASS_CONTROLS);
    return () => { stop(); document.documentElement.removeAttribute("data-glass"); };
  }, [glass]);
  return null;
}
