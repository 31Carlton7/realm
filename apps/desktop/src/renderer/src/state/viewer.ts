import { WRITE_TOOL_NAMES, bareToolName, mediaCandidatesIn, writtenPathOf, type AgentKind, type ArtifactKind } from "@realm/contracts";
import type { Block } from "../panes/session/transcript-model";

/**
 * The media viewer, as data: what it is showing, who its prompter talks to, and where in that
 * session's transcript its own exchange begins.
 *
 * One viewer for every file the app shows — the transcript's pictures and players, a prompter's or a
 * sent message's attachments, the Library's tiles, the documents pane's home, a session's summary and
 * its file browser. They each used to open their own: a lightbox for media, a sheet for everything
 * else, and the same screenshot reached from two lists opened two different ways. A list decides
 * WHICH files and which one first; everything after that is this.
 */

/** Where a file came from, when the surface showing it knows. The Library's index carries all four;
 *  a transcript or a session summary knows the path and nothing else, and draws no provenance rather
 *  than a half-filled one. */
export type FileProvenance = {
  sessionId: string;
  /** The space the session was in when the row was indexed. `revealSession` prefers its own live
   *  answer — a session that has since been MOVED would otherwise send the user to the old space. */
  spaceId: string;
  sessionTitle: string;
  kind: ArtifactKind;
};

/**
 * One file the viewer can show. `mime` and `name` where the list that opened it knew them — the
 * prompter's chips carry the picker's — and derived from the path where it did not.
 *
 * Provenance and the documents pane's reach are the FILE's, not the viewer's: the Library's page is
 * files from many sessions, and walking it with → moves the prompter to whichever session made the
 * file now on show.
 */
export type ViewerFile = {
  path: string; mime?: string; name?: string;
  from?: FileProvenance | null;
  /** Whether the documents pane can open it, from a list that knows. The kind alone says so for the
   *  space's own checkout; the documents pane's home answers for files OUTSIDE the checkout it is
   *  rooted at, which no kind can make it reach. */
  inPane?: boolean;
};

export type OpenViewerInput = {
  /** The file and its siblings — the strip it sat in, the message's other attachments, the Library's
   *  page — in the order the list shows them, so ←/→ walks them the way the eye just did. */
  files: readonly ViewerFile[];
  index?: number;
  /**
   * The session the media came from: the owner of the prompter docked under it. Its agent made the
   * file, or was handed it, so it knows what the file is for — a request to change one detail of a
   * picture is a request about the work that made it. A file's own provenance, where it has one,
   * names its session instead.
   */
  sessionId?: string | null;
  /** Where a session is made on the first send when there is none to ask — a Library file whose
   *  session has since been deleted, a documents pane of its own. */
  spaceId?: string | null;
  /** Where the keyboard goes back to on close. The element that had focus when the viewer opened,
   *  when the caller does not know better. */
  opener?: HTMLElement | null;
};

export type ViewerState = {
  files: ViewerFile[];
  index: number;
  /** The owner of every file without provenance of its own — and, once the viewer has made one, of
   *  every file whose own session is gone. */
  sessionId: string | null;
  spaceId: string | null;
  /**
   * Where this viewer's own exchange begins in its session's transcript, or null before its first
   * send: the block count then, and the moment it went. The exchange starts at the first user
   * message past both — a session mid-turn when the question went out goes on writing ITS turn first,
   * and that is not this exchange's; and a transcript still loading when the question went has no
   * count to trust, where the clock still says which question came after it.
   */
  thread: { sessionId: string; from: number; at: number } | null;
  /** The viewed file the person took off the next message. It comes back on with the next file
   *  viewed, or once the message has gone — the default is that a question about a file carries it. */
  detached: string | null;
  /** The agent and model a session made on the first send will run, picked in the viewer's own
   *  prompter while there is no session yet. Null takes the last agent used. */
  pick: { agentKind: AgentKind; model: string | null } | null;
  opener: HTMLElement | null;
};

/** The viewer prompter's draft and its extra files, in the store's per-session maps under a key of
 *  its own: `setDraft`, `attachFiles` and the attachment cap all apply to it unchanged, and the draft
 *  survives the viewer closing on a stray Escape the way a session's survives a pane remount. */
export const VIEWER_SLOT = "media-viewer";

/**
 * Whom the prompter asks about `file`: the session it came from while that can still be reached, and
 * otherwise the viewer's own — the session the surface that opened it belongs to, or the one a first
 * send made. Null is nobody yet: the next send makes a session.
 */
export function ownerOf(v: Pick<ViewerState, "sessionId">, file: ViewerFile | undefined, reachable: (sessionId: string) => boolean): string | null {
  const own = file?.from?.sessionId;
  if (own && reachable(own)) return own;
  return v.sessionId && reachable(v.sessionId) ? v.sessionId : null;
}

/** Where this viewer's exchange starts in `blocks`: the first user message at or after `from`, sent
 *  no earlier than `at`, or -1 while the question has not landed (a send queued behind a turn). */
export function exchangeStart(blocks: readonly Block[], from: number, at = 0): number {
  for (let i = Math.max(0, from); i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind === "user" && b.ts >= at) return i;
  }
  return -1;
}

/** An agent's path, absolute: a relative one is relative to where the agent was standing. `~/` stays
 *  as written — only main can expand it, and the media scheme does. */
function absolute(path: string, cwd: string | null): string | null {
  if (path.startsWith("/") || path.startsWith("~/")) return path;
  if (!cwd) return null;
  const rel = path.replace(/^(\.\/)+/, "");
  return rel ? `${cwd.replace(/\/+$/, "")}/${rel}` : null;
}

/**
 * The files an exchange produced, as candidates for main to confirm: every file a write tool wrote,
 * then every piece of media the answer pointed at, in the order they appeared.
 *
 * Both, because agents change a picture both ways: a script that writes `hero-warm.png` is a Bash
 * call the index cannot see, and is found by the answer naming it — the transcript's own media strip
 * reads the same prose the same way (`mediaCandidatesIn`). A Write that failed wrote nothing, and a
 * message still streaming may be half a path; neither is a candidate.
 */
export function exchangeResults(blocks: readonly Block[], cwd: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | null) => { if (p && !seen.has(p)) { seen.add(p); out.push(p); } };
  for (const b of blocks) {
    if (b.kind === "tool" && b.result && !b.result.isError && WRITE_TOOL_NAMES.has(bareToolName(b.name))) {
      const written = writtenPathOf(b.input);
      add(written && absolute(written, cwd));
    }
    if (b.kind === "assistant" && !b.streaming) for (const p of mediaCandidatesIn(b.text, cwd)) add(p);
  }
  return out;
}
