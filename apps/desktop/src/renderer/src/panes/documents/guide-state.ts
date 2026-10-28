import { GUIDE_STATE_MARK, GUIDE_STATE_MAX_CHARS, type GuideState } from "@realm/contracts";

/**
 * What each study guide was in the middle of, kept across the unmounts that reload its frame: another
 * file's tab, another session, another space (the documents pane is a tab of a session's side panel,
 * and goes when the session does). The runtime inside the frame reports it (`guide-runtime.ts`); this
 * holds it per guide — per documents workspace and path — and the frame is made with it again.
 *
 * The same lifetime as `scroll-memory.ts`, for the same reason: a handful of objects, held for the
 * run, is what a reader is owed back, and keeping every guide's frame alive for it is not.
 *
 * What outlives a RELAUNCH is decided by what each part is, the way a browser decides it:
 *
 *  - The guide's own `localStorage` does, written to the guide's progress sidecar (`persistStorage`).
 *    A guide that keeps its progress there asked for storage that lasts — a course of lessons is
 *    worked through over days, and quitting Realm, or an update restarting it, is not the reader
 *    starting over. In a browser it would still be there.
 *  - Everything else stays within the run: the answers picked but not checked, a flipped card, a
 *    step, an open section, the scroll, and `sessionStorage` (which a browser drops with the tab
 *    too). That is the page as it stood, not progress, and a relaunch is a new sitting — the same
 *    rule scroll-memory keeps. What a reader scored is already kept, as attempts in the sidecar.
 */

const states = new Map<string, GuideState>();

export const guideStateKey = (documentsId: string, path: string): string => `${documentsId}:${path}`;

export function rememberGuideState(key: string, state: GuideState): void {
  states.set(key, state);
}

export function recallGuideState(key: string): GuideState | null {
  return states.get(key) ?? null;
}

/** Test seam only, as `forgetAllScroll` is: the states are process-wide, so a suite that did not clear
 *  them would hand one test's answers to the next test's guide. */
export function forgetAllGuideStates(): void {
  states.clear();
  for (const t of storageWrites.values()) clearTimeout(t.timer);
  storageWrites.clear();
  persisted.clear();
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStorage = (v: unknown): v is Record<string, string> => isRecord(v) && Object.values(v).every((x) => typeof x === "string");

/**
 * A state as a frame posted it, or null. The frame is a page an agent wrote, so what it sends is
 * checked for shape and refused past the size a guide may keep; the widgets are the runtime's own to
 * read back and are held as they came.
 */
export function guideStateFrom(raw: unknown): GuideState | null {
  if (!isRecord(raw) || raw.v !== 1) return null;
  if (raw.hash !== undefined && typeof raw.hash !== "string") return null;
  if (raw.top !== undefined && typeof raw.top !== "number") return null;
  if (raw.local !== undefined && !isStorage(raw.local)) return null;
  if (raw.session !== undefined && !isStorage(raw.session)) return null;
  if (raw.widgets !== undefined && !isRecord(raw.widgets)) return null;
  let size: number;
  try { size = JSON.stringify(raw).length; } catch { return null; }
  if (size > GUIDE_STATE_MAX_CHARS) return null;
  return raw as GuideState;
}

/**
 * The frame's `name`: the envelope the runtime's boot reads before any of the guide's own scripts run,
 * which is how a guide's storage is already there when the guide first asks for it. `doc` is what the
 * runtime will find in its own URL — the workspace and the path — so a page the frame navigates to
 * is never handed this one's state. Empty when there is nothing to hand over.
 */
export function guideEnvelope(doc: string, state: GuideState | null, top: number | null): string {
  if (!state && !(top && top > 0)) return "";
  const handed: GuideState = { ...(state ?? { v: 1 }) };
  if (top && top > 0) handed.top = top;
  return JSON.stringify({ k: GUIDE_STATE_MARK, doc, state: handed });
}

/* ---- the guide's localStorage, written through to its sidecar ---------------------------------- */

/** How long the storage settles before it is written. A course saves on every answer; the sidecar
 *  needs the last of a burst, not each one. Short, because the window can close at any moment. */
export const STORAGE_WRITE_MS = 500;

/** What each guide's sidecar was last given (or was read holding), so a state that changed nothing
 *  in storage — most of them: a card flipped, a step taken — writes nothing. */
const persisted = new Map<string, string>();
const storageWrites = new Map<string, { timer: ReturnType<typeof setTimeout> }>();

/** Note what the sidecar already holds, when it was read to seed a frame. */
export function notePersisted(key: string, storage: Record<string, string>): void {
  persisted.set(key, JSON.stringify(storage));
}

/**
 * Write the guide's storage to its sidecar, a moment after it last changed. Module-level, not the
 * frame's: the write is owed whether or not the pane is still on screen when it falls due.
 */
export function persistStorage(key: string, storage: Record<string, string>, write: (storage: Record<string, string>) => Promise<unknown>): void {
  const text = JSON.stringify(storage);
  const pending = storageWrites.get(key);
  if (pending) clearTimeout(pending.timer);
  if (persisted.get(key) === text || (!persisted.has(key) && text === "{}")) { storageWrites.delete(key); return; }
  const timer = setTimeout(() => {
    storageWrites.delete(key);
    persisted.set(key, text);
    void write(storage).catch(() => { persisted.delete(key); });
  }, STORAGE_WRITE_MS);
  storageWrites.set(key, { timer });
}
