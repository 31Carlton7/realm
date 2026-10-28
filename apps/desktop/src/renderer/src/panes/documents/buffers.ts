import { documentKindFor } from "@realm/contracts";

/**
 * One open document's editing state, and the transitions between them (Plan 17 W1).
 *
 * Extracted as pure functions on purpose: this is where the conflict policy actually lives, and the
 * failure it prevents — an agent's write and the user's unsaved paragraph destroying one another — is
 * invisible in a rendered pane and obvious in a table of transitions.
 */
export type Conflict = { theirs: string; theirHash: string };

/** Files the pane opens WITHOUT reading their bytes: a PDF, everything Quick Look renders for us,
 *  and a video. The first two are fetched from the preview server — the PDF's bytes by pdf.js, the
 *  rest as Quick Look's picture — and a video is streamed to the player by main, so pulling a `.docx`
 *  or an `.mp4` through `readDocument` would only produce mojibake and a failed open. Their buffer's
 *  text is the empty string, always, which is why one is never written (`mayWrite`). */
export const isBinaryKind = (path: string): boolean => {
  const k = documentKindFor(path);
  return k === "pdf" || k === "preview" || k === "video";
};

export type Buffer = {
  path: string;
  /** What the editor shows. */
  text: string;
  /** Hash of the disk content this buffer is based on — the `baseHash` its next save will send. */
  baseHash: string | null;
  /** The reader typed something that is not on disk yet — and nothing else. A file vanishing is
   *  `missing`, not this: the pane writes only what was typed, so a buffer marked dirty for any other
   *  reason is a buffer the pane will write over whatever an agent has put there since. */
  dirty: boolean;
  /** Set when disk moved under an unsaved buffer. The editor stays editable; the bar offers a choice. */
  conflict: Conflict | null;
  /** The file was deleted underneath an open editor. The tab stays open with the text it had, and the
   *  file comes back only when the reader asks for it (`canRecreate`). */
  missing: boolean;
};

export function opened(path: string, text: string, hash: string): Buffer {
  return { path, text, baseHash: hash, dirty: false, conflict: null, missing: false };
}

export function edited(b: Buffer, text: string): Buffer {
  if (text === b.text) return b;
  return { ...b, text, dirty: true };
}

/** A save succeeded: the buffer is now based on what it just wrote. */
export function saved(b: Buffer, hash: string): Buffer {
  return { ...b, baseHash: hash, dirty: false, conflict: null, missing: false };
}

/**
 * The file changed on disk underneath us. `text` is null when it was deleted.
 *
 * The clean case reloads silently — that is the whole point of the live-reload story, and a prompt on
 * every agent edit to a document you are only reading would make the feature unusable. The dirty case
 * NEVER adopts: it raises a conflict and leaves the user's text exactly where it is. Getting this
 * branch backwards is the one bug in this file that destroys work rather than merely annoying.
 */
export function externalChange(b: Buffer, text: string | null, hash: string | null): Buffer {
  if (hash === null || text === null) {
    // Deleted. Keep the text — for a dirty buffer it is the only remaining copy, and for a clean one
    // it is still what the user was reading — and leave `dirty` saying only whether they typed. This
    // used to mark the buffer dirty "so a save could rescue it", and the pane's saves then put every
    // deleted file back: an agent's `git checkout` or `mv` found an untracked copy in its way, and a
    // PDF rebuilt behind its tab was written over with the empty buffer, 0 bytes. A conflict pending
    // on the file goes too: there is no "theirs" left to take.
    return { ...b, missing: true, conflict: null };
  }
  // The file exists, so it is not missing any more — whatever else this event turns out to mean.
  // Leaving `missing` set alongside a conflict would render two contradictory states at once.
  if (hash === b.baseHash) return b.missing ? { ...b, missing: false } : b; // nothing we did not already know
  if (!b.dirty) return { ...b, text, baseHash: hash, dirty: false, conflict: null, missing: false };
  // Disk now holds exactly what the reader typed — their own write landing late, or someone writing the
  // same words. There is nothing to decide, and a conflict bar over two identical texts asks anyway.
  if (text === b.text) return saved(b, hash);
  return { ...b, conflict: { theirs: text, theirHash: hash }, missing: false };
}

/**
 * A file the pane holds no text for (`isBinaryKind`) changed on disk — rewritten in place, or made
 * again after a delete. Its hash is adopted, which is what re-renders the view; it exists, so it is not
 * missing; and there is nothing of the reader's in it to be unsaved, so it is not dirty either.
 */
export function binaryChanged(b: Buffer, hash: string): Buffer {
  return { ...b, baseHash: hash, dirty: false, conflict: null, missing: false };
}

/** The server refused a save because disk had moved — same state as an observed external change,
 *  including that a disk already holding the reader's text is not a conflict. */
export function writeRejected(b: Buffer, currentText: string, currentHash: string): Buffer {
  if (currentText === b.text) return saved(b, currentHash);
  return { ...b, conflict: { theirs: currentText, theirHash: currentHash }, dirty: true };
}

/**
 * Keep the user's version. The buffer re-bases onto the content it is overwriting, so the next save
 * is no longer stale and will succeed — that re-base is what makes the button do what it says.
 */
export function keepMine(b: Buffer): Buffer {
  if (!b.conflict) return b;
  return { ...b, baseHash: b.conflict.theirHash, conflict: null, dirty: true };
}

/** Take the version on disk, discarding the user's unsaved edits. */
export function takeTheirs(b: Buffer): Buffer {
  if (!b.conflict) return b;
  return { ...b, text: b.conflict.theirs, baseHash: b.conflict.theirHash, conflict: null, dirty: false, missing: false };
}

/** Whether the pane may save this buffer on its own — the autosave, or the write as a file is left:
 *  typing not on disk yet, no unresolved conflict, and a file that is still there. */
export function canSave(b: Buffer): boolean {
  return b.dirty && b.conflict === null && !b.missing;
}

/** Whether the file can be put back with what the reader typed into it after it was deleted — a
 *  decision the bar asks for (Keep mine), never one a save makes for them. A deleted file nobody typed
 *  into stays deleted. */
export function canRecreate(b: Buffer): boolean {
  return b.missing && b.dirty && b.conflict === null;
}

/**
 * The whole of what may be written from the pane, in one place. Only typing the reader did and that is
 * not on disk yet: never a file the pane holds no text for (its empty buffer would empty the file,
 * whatever state the buffer is in), and a deleted file only when the reader has asked for it back.
 */
export function mayWrite(b: Buffer, recreate = false): boolean {
  if (isBinaryKind(b.path)) return false;
  return canSave(b) || (recreate && canRecreate(b));
}
