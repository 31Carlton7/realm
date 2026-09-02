/**
 * One open document's editing state, and the transitions between them (Plan 17 W1).
 *
 * Extracted as pure functions on purpose: this is where the conflict policy actually lives, and the
 * failure it prevents — an agent's write and the user's unsaved paragraph destroying one another — is
 * invisible in a rendered pane and obvious in a table of transitions.
 */
export type Conflict = { theirs: string; theirHash: string };

export type Buffer = {
  path: string;
  /** What the editor shows. */
  text: string;
  /** Hash of the disk content this buffer is based on — the `baseHash` its next save will send. */
  baseHash: string | null;
  dirty: boolean;
  /** Set when disk moved under an unsaved buffer. The editor stays editable; the bar offers a choice. */
  conflict: Conflict | null;
  /** The file was deleted underneath an open editor. The tab stays open; saving re-creates it. */
  missing: boolean;
};

export function opened(path: string, text: string, hash: string): Buffer {
  return { path, text, baseHash: hash, dirty: false, conflict: null, missing: false };
}

/** A brand-new document the user has not saved yet: no disk content to be based on. */
export function created(path: string, text: string): Buffer {
  return { path, text, baseHash: null, dirty: true, conflict: null, missing: false };
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
    // it is still what the user was reading. Saving re-creates the file.
    return { ...b, missing: true, dirty: true };
  }
  // The file exists, so it is not missing any more — whatever else this event turns out to mean.
  // Leaving `missing` set alongside a conflict would render two contradictory states at once.
  if (hash === b.baseHash) return b.missing ? { ...b, missing: false } : b; // nothing we did not already know
  if (!b.dirty) return { ...b, text, baseHash: hash, dirty: false, conflict: null, missing: false };
  return { ...b, conflict: { theirs: text, theirHash: hash }, missing: false };
}

/** The server refused a save because disk had moved — same state as an observed external change. */
export function writeRejected(b: Buffer, currentText: string, currentHash: string): Buffer {
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

/** Whether a save may be attempted: something to write, and no unresolved conflict to resolve first. */
export function canSave(b: Buffer): boolean {
  return b.dirty && b.conflict === null;
}
