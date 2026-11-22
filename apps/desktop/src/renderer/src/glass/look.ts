/**
 * Which look the app's floating controls wear: plain, or glass. One setting for all of them (the
 * prompter, its pickers, segmented controls, switches and the selection bar), so a person chooses a
 * material once rather than per control (the owner, 11-17: "I want that reflected here throughout the
 * app as well"). Reading surfaces (Settings pages, sheets, the transcript) stay plain either way.
 *
 * Glass is something a person switches on in Settings ▸ Appearance, never the default (the owner
 * banned glass on 11-04 and asked to see a take on 11-17). Even when it is chosen, three things put
 * plain back without touching the setting, so the choice comes back when they clear:
 * macOS Reduce Transparency, which asks for nothing to be see-through; the Mac's Low Power Mode,
 * which asks every app to spend less; and a renderer that cannot take `backdrop-filter: url()`, where
 * the filter would draw nothing at all. Settings names whichever one is holding glass back, because a
 * choice that silently does nothing reads as a broken one.
 *
 * Realm's own Low power is not one of them. It stops what repaints every frame, and it has already
 * stopped the loop behind the glass, so the lens has a still picture to bend and redraws only when
 * something moves under it. Holding glass back there was what made Glass look like a solid slab on
 * the owner's Mac, where Low power is on for good (11-18).
 */

import { SETTING_LOOK } from "@realm/contracts";

export type Look = "plain" | "glass";

export const LOOK_SETTING = SETTING_LOOK;
export const DEFAULT_LOOK: Look = "plain";

export function isLook(v: unknown): v is Look {
  return v === "plain" || v === "glass";
}

export type GlassConditions = {
  reduceTransparency: boolean;
  /** The Mac's Low Power Mode (`data-low-power-mode`). */
  lowPowerMode: boolean;
  supportsBackdropUrl: boolean;
};

/** Why glass, chosen, is drawn plain right now. */
export type PlainReason = "reduce-transparency" | "low-power-mode" | "no-backdrop-url";

export function plainReason(pref: Look, c: GlassConditions): PlainReason | null {
  if (pref !== "glass") return null;
  if (c.reduceTransparency) return "reduce-transparency";
  if (c.lowPowerMode) return "low-power-mode";
  if (!c.supportsBackdropUrl) return "no-backdrop-url";
  return null;
}

export function shownLook(pref: Look, c: GlassConditions): Look {
  return pref === "glass" && !plainReason(pref, c) ? "glass" : "plain";
}

/** What Settings says under the Controls row while glass is held back. */
export const PLAIN_REASON_TEXT: Record<PlainReason, string> = {
  "reduce-transparency": "Off while Reduce Transparency is on, in System Settings ▸ Accessibility ▸ Display",
  "low-power-mode": "Off while Low Power Mode is on, in System Settings ▸ Battery",
  "no-backdrop-url": "Off because this window cannot draw glass",
};

export function supportsBackdropUrl(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("backdrop-filter", "url(#a)");
}
