import { basenameOf, isImageMime, mimeForPath } from "./attachments";

/**
 * Local media in the transcript — the picture, the movie, the sound file an agent just made.
 *
 * The renderer cannot read a file and CSP refuses `file://`, so an attachment could until now only
 * ever be a 96px data: URL minted in main (`attachment-thumbnail`). That is the right answer for a
 * tile and the wrong one for a 20 MB mp4: base64 across the bridge is a third bigger than the file,
 * arrives all at once, and cannot be seeked. `realm-media://` is the streaming channel instead —
 * main serves the bytes with Range support, so a video starts on the first frame and scrubs.
 *
 * Nothing in here reads the filesystem. These are the shapes and the string handling both sides
 * agree on; whether a path actually exists is a question only main can answer, and every caller
 * asks it before drawing anything (`window.realm.media.stat`).
 */

/** The scheme main registers and CSP admits. Not `file:`: a scheme of our own is one main can gate. */
export const MEDIA_SCHEME = "realm-media";

/** The URL's host. A standard scheme must have one, and a fixed literal makes a malformed URL
 *  obvious rather than something that happens to parse as a path. */
const MEDIA_HOST = "f";

export const isVideoMime = (mime: string): boolean => mime.startsWith("video/");
export const isAudioMime = (mime: string): boolean => mime.startsWith("audio/");

/** What element plays this, or null for a file no element can. Deliberately mime-driven rather than
 *  extension-driven at the call sites, so one table (`mimeForPath`) governs both. */
export type MediaKind = "image" | "video" | "audio";
export function mediaKindFor(mime: string): MediaKind | null {
  if (isImageMime(mime)) return "image";
  if (isVideoMime(mime)) return "video";
  if (isAudioMime(mime)) return "audio";
  return null;
}

/** A file main will serve, by its path alone. This is the ONLY gate on the scheme, and it is
 *  deliberately a whitelist of inert formats: an `img`/`video`/`audio` element can decode a picture
 *  or a movie and can do nothing else with one. A `.ts` or a `.env` is not media and never resolves. */
export const isPlayablePath = (path: string): boolean => mediaKindFor(mimeForPath(path)) !== null;

/**
 * `realm-media://f/<the whole path, percent-encoded>`.
 *
 * The path is ONE encoded segment rather than a path-shaped one: `encodeURIComponent` escapes `/`
 * to `%2F`, which Chromium's URL canonicaliser preserves, so a filename containing a `?`, a `#`, a
 * space or a `%` survives the round trip intact. Building the URL by interpolating the raw path
 * would let any of those four truncate or re-point it.
 */
export function mediaUrl(path: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(path)}`;
}

/** The path back out of a media URL, or null if this is not one. Returns the path exactly as it was
 *  given — main is what decides whether it may be served. */
export function pathFromMediaUrl(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== MEDIA_HOST) return null;
  const encoded = parsed.pathname.replace(/^\//, "");
  if (encoded === "") return null;
  try {
    const path = decodeURIComponent(encoded);
    return path === "" ? null : path;
  } catch { return null; } // a malformed escape is not a path
}

/** One media file main confirmed is really there. `size` is a fact about the file on disk, so a card
 *  can say "10 MB" without the renderer having to have read it. */
export type MediaFile = { path: string; mime: string; kind: MediaKind; size: number };

/** How many candidates a single message may put to main. A message is prose, not a directory
 *  listing; past a couple of dozen names the thing being described is not "here is what I made". */
export const MAX_MEDIA_CANDIDATES = 24;

/* A path-shaped token: absolute, home-relative, or explicitly relative. Stops at whitespace and at
 * the punctuation prose wraps paths in — a trailing `.` or `,` belongs to the sentence, and a
 * closing bracket or quote belongs to the markdown around it. */
const PATH_TOKEN = /(?:~|\.{1,2})?(?:\/[^\s"'`()[\]<>|]+)+\/?/g;
/** A bare filename with an extension — what a table cell or a code span holds when the directory
 *  was named once in the surrounding prose. */
const NAME_TOKEN = /[\w][\w .@+-]*\.[A-Za-z0-9]{1,5}/g;

/** Trailing sentence punctuation, stripped after the match: prose ends "…in `~/Desktop/mockups/`."
 *  and the full stop is not part of the directory. A trailing `/` IS kept — it is what says the
 *  token is a directory. */
const trimEdge = (s: string): string => s.replace(/[.,;:!?)\]}'"`]+$/, "");

/**
 * Media paths an assistant message is POINTING AT, as absolute-ish candidates for main to check.
 *
 * Harvested from the message text and nothing else. A path that merely passed through a tool result
 * is not something the agent chose to show the reader — an `ls ~/Pictures` would otherwise put forty
 * holiday photos under a message about a build script. When the agent writes "the videos are in
 * `~/Desktop/mockups/`" and lists their names, it is telling the user to go and look, and that is
 * the case this exists for.
 *
 * Two shapes are joined, because that is how agents actually write it:
 *  - a full path (`~/Desktop/mockups/clip.mp4`) is a candidate as it stands;
 *  - a bare name (`clip.mp4`) is a candidate under every DIRECTORY the same message named, and under
 *    `cwd` — which is how the screenshot's table of three filenames plus one directory in the prose
 *    above it resolves to three real files.
 *
 * Everything returned is a GUESS. Nothing is drawn until main has stat'd it, so a wrong join costs
 * one failed stat and shows nothing.
 */
export function mediaCandidatesIn(text: string, cwd: string | null): string[] {
  const dirs: string[] = [];
  const full: string[] = [];
  const names: string[] = [];
  for (const m of text.matchAll(PATH_TOKEN)) {
    const token = trimEdge(m[0]);
    if (token.endsWith("/")) { dirs.push(token); continue; }
    if (isPlayablePath(token)) full.push(token);
    // A path to a non-media file still names the DIRECTORY its siblings live in — "wrote
    // ~/out/notes.md" is how a message about a folder of renders often starts.
    else {
      const cut = token.lastIndexOf("/");
      if (cut > 0) dirs.push(token.slice(0, cut + 1));
    }
  }
  for (const m of text.matchAll(NAME_TOKEN)) {
    const name = trimEdge(m[0]);
    // Only bare names: anything with a separator was already handled above, and a `.` at the front
    // is a dotfile rather than a render.
    if (!name.includes("/") && isPlayablePath(name)) names.push(name);
  }
  if (cwd) dirs.push(cwd.endsWith("/") ? cwd : `${cwd}/`);

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    if (seen.has(p) || out.length >= MAX_MEDIA_CANDIDATES) return;
    seen.add(p); out.push(p);
  };
  // Full paths first: they are stated rather than joined, so they are the ones worth the budget.
  for (const p of full) add(p);
  for (const name of names) {
    // A name that is already the basename of a stated path is that path, not a new candidate —
    // otherwise "`clip.mp4` is in ~/out/clip.mp4" would ask about the same file twice.
    if (full.some((p) => basenameOf(p) === name)) continue;
    for (const dir of dirs) add(dir + name);
  }
  return out;
}
