import type { IconName } from "@realm/ui";

/**
 * The window's toasts (v2): what a failed action, a refused attachment or a browser pane's receipt
 * tells the person, at the foot of the window, for as long as it takes to read.
 *
 * It replaced a red bar across the top of the main area that stayed until it was dismissed. A notice
 * about something that already happened is read once; a bar that has to be closed by hand is a chore,
 * and at the top of the window it sat over the pane bars a person is reaching for. Things that need a
 * DECISION — a permission, a sign-in, a server that has gone — are not toasts and do not come here:
 * they stay where they are until they are answered.
 *
 * Pure, so what is kept, what is dropped and how long each one stays are testable without a window.
 */
export type ToastTone = "error" | "warning" | "success" | "info";

/** The one thing a toast can do besides go: take back what it reports — a removal's Undo. A notice
 *  about something that happened may offer to unhappen it; it never asks a question (design.md). */
export type ToastAction = { label: string; run: () => void };

export type Toast = {
  id: string;
  tone: ToastTone;
  text: string;
  /** The glyph, when the toast's PURPOSE says more than its tone — a picked element's target, a
   *  screenshot's picture. Null wears the tone's own. */
  icon: IconName | null;
  /** How long it is up, in ms, not counting the time it spends paused (pointer on the stack, focus in
   *  it, the window not key). */
  life: number;
  action: ToastAction | null;
};

export type ToastInput = { text: string; tone?: ToastTone; icon?: IconName; life?: number; action?: ToastAction };

/** How many are on screen at once. A fourth pushes the oldest off: three is as many as anyone reads
 *  in the few seconds each one is up, and a stack taller than that is a wall over the work. */
export const TOAST_LIMIT = 3;

/** The floor each tone gets before its words are counted. An error is the one a person has to act
 *  on, so it waits longest; a receipt for something they just watched happen is gone soonest. */
const LIFE_FLOOR: Record<ToastTone, number> = { error: 6000, warning: 5000, success: 4000, info: 4000 };
/** Reading time, at a little under the 16 characters a second people skim at, and the ceiling
 *  past which a toast has stopped being a toast. */
const MS_PER_CHAR = 55;
const LIFE_CAP = 10_000;
/** The floor of a toast that offers to take back what it reports. The offer is what it is there for,
 *  and it has to be read, found and pressed before the line reaches the end. */
const ACTION_FLOOR = 8000;

/** How long a toast stays: its tone's floor, or the time it takes to read, whichever is longer — a
 *  path in an error is most of its length, and four seconds is not long enough to find the folder
 *  name in one. Capped, because a toast that waits a minute is a banner by another name. */
export function toastLife(tone: ToastTone, text: string, action = false): number {
  return Math.min(LIFE_CAP, Math.max(action ? ACTION_FLOOR : LIFE_FLOOR[tone], 1000 + text.length * MS_PER_CHAR));
}

/**
 * The list once `input` has arrived: newest LAST, at most `TOAST_LIMIT`.
 *
 * The same words in the same tone are one toast, not two. A poll that fails every few seconds would
 * otherwise fill the stack with copies of itself; instead the one already up comes to the front
 * under a new id — which restarts its time and plays its entrance again, so "it happened again" is
 * still said, once. Never a toast with an action: two removals that read alike are two things to
 * undo, and folding them would take the first one's Undo away.
 */
export function pushToast(list: readonly Toast[], input: ToastInput, id: string): Toast[] {
  const tone = input.tone ?? "info";
  const text = input.text.trim();
  const action = input.action ?? null;
  const next: Toast = { id, tone, text, icon: input.icon ?? null, life: input.life ?? toastLife(tone, text, action !== null), action };
  const rest = action ? [...list] : list.filter((t) => !(t.tone === tone && t.text === text && t.action === null));
  return [...rest, next].slice(-TOAST_LIMIT);
}
