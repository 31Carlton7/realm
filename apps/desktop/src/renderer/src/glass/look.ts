/**
 * Which look the app's floating controls wear: plain, or glass. One setting for all of them (the
 * prompter, its pickers, segmented controls, switches and the selection bar), so a person chooses a
 * material once rather than per control (the owner, 11-17: "I want that reflected here throughout the
 * app as well"). Reading surfaces (Settings pages, sheets, the transcript) stay plain either way.
 *
 * Glass is something a person switches on in Settings ▸ Appearance, never the default (the owner
 * banned glass on 11-04 and asked to see a take on 11-17). Even when it is chosen, three things put
 * plain back without touching the setting, so the choice comes back when they clear:
 * macOS Reduce Transparency, which asks for nothing to be see-through; Low power, Realm's own switch
 * or the Mac's Low Power Mode, because the lens re-filters every frame a loop plays behind it; and a
 * renderer that cannot take `backdrop-filter: url()`, where the filter would draw nothing at all.
 */

export type Look = "plain" | "glass";

export const LOOK_SETTING = "ui.look";
export const DEFAULT_LOOK: Look = "plain";

export function isLook(v: unknown): v is Look {
  return v === "plain" || v === "glass";
}

export type GlassConditions = {
  reduceTransparency: boolean;
  /** Realm's own Low power setting. */
  lowPower: boolean;
  /** The Mac's Low Power Mode (`data-low-power-mode`). */
  lowPowerMode: boolean;
  supportsBackdropUrl: boolean;
};

export function shownLook(pref: Look, c: GlassConditions): Look {
  if (pref !== "glass") return "plain";
  if (c.reduceTransparency || c.lowPower || c.lowPowerMode || !c.supportsBackdropUrl) return "plain";
  return "glass";
}

export function supportsBackdropUrl(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("backdrop-filter", "url(#a)");
}
