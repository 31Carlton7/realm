import type { PairedPhone } from "@realm/contracts";
import { encode } from "uqr";

/**
 * What a phone calls itself, by the identifier it reports (`utsname.machine`, `iPhone18,1`), for the
 * iPhones that run iOS 26 and later. An identifier missing here is shown as it is: a wrong name is
 * worse than the code it was guessed from, and a newer phone's code still says what it is.
 */
export const PHONE_MODELS: Readonly<Record<string, string>> = {
  "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max",
  "iPhone12,8": "iPhone SE (2nd generation)",
  "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
  "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13", "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
  "iPhone14,6": "iPhone SE (3rd generation)",
  "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus", "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max",
  "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus", "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
  "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max",
  "iPhone17,5": "iPhone 16e",
  "iPhone18,3": "iPhone 17", "iPhone18,4": "iPhone Air", "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max",
};

export function phoneModelName(identifier: string): string {
  return Object.prototype.hasOwnProperty.call(PHONE_MODELS, identifier) ? PHONE_MODELS[identifier]! : identifier;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "4 min ago", "3 hours ago", "yesterday", "5 days ago", then the date. */
export function sinceLabel(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) { const h = Math.floor(ms / HOUR); return `${h} ${h === 1 ? "hour" : "hours"} ago`; }
  const d = Math.floor(ms / DAY);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  return `on ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

/** The line under a phone's name: what it is, and when this Mac last heard from it. A phone that has
 *  not connected since it was paired says when it was paired instead, rather than leaving a blank. */
export function phoneDetail(phone: PairedPhone, now: number): string {
  const seen = phone.lastSeen !== null ? `Last seen ${sinceLabel(phone.lastSeen, now)}` : `Paired ${sinceLabel(phone.addedAt, now)}`;
  return `${phoneModelName(phone.model)} · ${seen}`;
}

/** A countdown as a clock reads it, "4:59", never below zero. */
export function clockLabel(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The quiet zone the QR specification asks for, in modules. A scanner finds the code by the light
 *  border round its three corner squares; without it the window's own edges read as part of it. */
export const QUIET_ZONE = 4;

/**
 * A pairing link as a QR code: the side in modules, quiet zone included, and one SVG path of its dark
 * modules in that grid — a run of dark modules along a row is one rectangle, so the path stays a few
 * thousand characters for a link the length a real one is.
 *
 * Error correction M (15%): a code on a screen is not torn or smudged, but a camera reading glass at
 * an angle meets glare and moiré. For a link the length a real one is, M is 85 modules a side where L
 * is 77, and the sheet still draws every module three CSS pixels wide.
 */
export function qrCode(text: string): { size: number; path: string } {
  const { size, data } = encode(text, { ecc: "M", border: QUIET_ZONE });
  let path = "";
  data.forEach((row, y) => {
    for (let x = 0; x < size;) {
      if (!row[x]) { x++; continue; }
      let run = 1;
      while (x + run < size && row[x + run]) run++;
      path += `M${x} ${y}h${run}v1h-${run}z`;
      x += run;
    }
  });
  return { size, path };
}
