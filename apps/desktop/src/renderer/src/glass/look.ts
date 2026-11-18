/**
 * Which look the app's floating controls wear: plain, or glass. One setting for all of them (the
 * prompter, its pickers, segmented controls, switches and the selection bar), so a person chooses a
 * material once rather than per control (the owner, 11-17: "I want that reflected here throughout the
 * app as well"). Reading surfaces (Settings pages, sheets, the transcript) stay plain either way.
 *
 * Glass is something a person switches on in Settings ▸ Appearance, never the default (the owner
 * banned glass on 11-04 and asked to see a take on 11-17). Even when it is chosen, four things put
 * plain back without touching the setting, so the choice comes back when they clear:
 * macOS Reduce Transparency, which asks for nothing to be see-through; the Mac's Low Power Mode,
 * which asks every app to spend less; Realm's own Low power, which keeps the app's motion off; and a
 * renderer that cannot take `backdrop-filter: url()`, where the filter would draw nothing at all.
 * Settings names whichever one is holding glass back, because a choice that silently does nothing
 * reads as a broken one, and for Realm's Low power it offers to turn it off right there.
 */

export type Look = "plain" | "glass";

export const LOOK_SETTING = "ui.look";
export const DEFAULT_LOOK: Look = "plain";

export function isLook(v: unknown): v is Look {
  return v === "plain" || v === "glass";
}

export type GlassConditions = {
  reduceTransparency: boolean;
  /** Realm's own Low power setting (`ui.lowPower`). */
  lowPower: boolean;
  /** The Mac's Low Power Mode (`data-low-power-mode`). */
  lowPowerMode: boolean;
  supportsBackdropUrl: boolean;
};

/** Why glass, chosen, is drawn plain right now. */
export type PlainReason = "reduce-transparency" | "low-power-mode" | "low-power" | "no-backdrop-url";

export function plainReason(pref: Look, c: GlassConditions): PlainReason | null {
  if (pref !== "glass") return null;
  if (c.reduceTransparency) return "reduce-transparency";
  if (c.lowPowerMode) return "low-power-mode";
  if (c.lowPower) return "low-power";
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
  "low-power": "Off while Low power is on",
  "no-backdrop-url": "Off because this window cannot draw glass",
};

export function supportsBackdropUrl(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("backdrop-filter", "url(#a)");
}
