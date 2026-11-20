/**
 * The keys Realm answers from any app (Settings ▸ Keys ▸ From anywhere): a double-tap of Command,
 * and chords on one modifier held alone. A native helper sees them (`native/RealmKeys.swift`), since
 * Electron's `globalShortcut` cannot see a bare modifier or Fn; main runs it only while one of these
 * is wanted (`main/realm-keys.ts`).
 */

/** Whether a double-tap of Command opens the quick chat. On unless turned off: it was asked for. */
export const KEYS_DOUBLE_TAP_KEY = "keys.doubleTapCommand";
export const KEYS_DOUBLE_TAP_DEFAULT = true;

/**
 * The modifier held for assistant chords. Fn unless changed. The other two exist because some
 * keyboards handle Fn inside the keyboard and never send it to the Mac.
 */
export const KEYS_HOLD_KEY = "keys.assistantHold";
export const HOLD_KEYS = ["fn", "rightOption", "rightCommand"] as const;
export type HoldKey = (typeof HOLD_KEYS)[number];
export const HOLD_KEY_DEFAULT: HoldKey = "fn";
export const isHoldKey = (x: unknown): x is HoldKey => HOLD_KEYS.includes(x as HoldKey);
export const HOLD_KEY_LABEL: Record<HoldKey, string> = { fn: "Fn", rightOption: "Right Option", rightCommand: "Right Command" };

/**
 * What the helper is doing.
 *  - `off`: nothing needs it, so it is not running.
 *  - `starting`: started, and it has not said which tap it got.
 *  - `active`: it sees the keys, and macOS would let it keep a chord from the app in front (Accessibility).
 *  - `listening`: it sees the keys, and macOS would not let it keep any back (Input Monitoring only).
 *  - `denied`: macOS lets Realm see no keys outside its own windows. No tap was made, and nothing asked.
 *  - `missing`: there is no helper to run (not a Mac, or not built), or it stopped unasked.
 */
export type GlobalKeysState = "off" | "starting" | "active" | "listening" | "denied" | "missing";

/** What Settings' "Try it" row is told while it is on screen. */
export type GlobalKeysEvent = { t: "doubleTap" } | { t: "hold"; down: boolean };
