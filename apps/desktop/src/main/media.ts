import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import {
  MEDIA_SCHEME, isPlayablePath, mediaKindFor, mimeForPath, pathFromMediaUrl, type MediaFile,
} from "@realm/contracts";
import { quickLookThumbnail } from "./attachments";

/**
 * Serving local media to the renderer.
 *
 * The renderer has no filesystem access and the page's CSP refuses `file://`, so a picture or a
 * movie on disk can only be NAMED there unless something carries the bytes across. `attachment-
 * thumbnail` does that for a 96px tile by minting a data: URL, and that approach does not scale to
 * a video: base64 is a third larger than the file, it arrives in one piece, and an element handed
 * one cannot seek. `realm-media://` is the streaming answer — `net.fetch` over a `file://` URL
 * honours Range requests, so the player starts on the first frame and scrubbing works.
 *
 * The gate is deliberately narrow and lives in ONE function (`servablePath`): the path must resolve
 * to a real file whose extension maps to an image, video or audio mime. Everything else — source,
 * config, a `.env` — has no mime in Realm's table that `mediaKindFor` accepts, so it can never be
 * fetched through this scheme however the URL is spelled.
 */

/** `~` and `~/…`, which is how agents write paths in prose far more often than they write `/Users/…`.
 *  Anything else is returned unchanged; a bare `~user` form is NOT expanded, because guessing another
 *  account's home would be inventing a path rather than resolving one. */
export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/**
 * The absolute path this candidate names, or null if it is not one Realm will serve.
 *
 * The extension is checked TWICE, on either side of the filesystem, and both checks are load-bearing:
 *  - before, on the `..`-collapsed string, so a non-media file cannot be reached by climbing and the
 *    cheap refusal costs no syscall;
 *  - after, on the fully-resolved real path, so a symlink cannot lend its own extension to something
 *    else. An agent has write access to its workspace, and `evil.mp4 -> ~/.ssh/id_rsa` is a link it
 *    could make and then embed in a message. The link's name says mp4; `realpath` says otherwise.
 *
 * A symlink to real media still works — a render written into a symlinked output directory is an
 * ordinary thing, and the target's extension agrees with the link's.
 */
export async function servablePath(candidate: string, home = homedir()): Promise<string | null> {
  if (typeof candidate !== "string" || candidate === "") return null;
  const expanded = expandHome(candidate, home);
  // A relative path has no meaning here: the renderer's cwd is the app bundle, not the agent's
  // workspace, so resolving one against it would answer a question nobody asked.
  if (!isAbsolute(expanded)) return null;
  const path = resolve(expanded);
  if (!isPlayablePath(path)) return null;
  try {
    // `realpath` resolves every link in the chain and throws when the target is missing, which is
    // also the existence check — one syscall doing both.
    const real = await realpath(path);
    if (!isPlayablePath(real)) return null;
    if (!(await stat(real)).isFile()) return null;
    // The LINK's path is returned, not the target's: it is what the user was shown and what the
    // reveal-in-Finder button should select. Both have passed the same gate.
    return path;
  } catch { return null; }
}

/**
 * One answer per candidate, in the order they were asked about: the file it names, or null.
 *
 * ALIGNED rather than filtered, because the two strings are generally not the same one — the caller
 * asks about `~/Desktop/mockups/clip.mp4` and the answer's path is `/Users/…/Desktop/mockups/clip.mp4`.
 * A filtered list would leave the renderer unable to say which of its guesses came back, and it
 * caches those answers by the string it asked with.
 */
export async function statMedia(candidates: readonly string[], home = homedir()): Promise<(MediaFile | null)[]> {
  const out: (MediaFile | null)[] = [];
  for (const candidate of candidates) {
    const path = await servablePath(candidate, home);
    const mime = path ? mimeForPath(path) : "";
    const kind = mime ? mediaKindFor(mime) : null;
    if (!path || !kind) { out.push(null); continue; }
    try {
      const s = await stat(path);
      out.push({ path, mime, kind, size: s.size });
    } catch { out.push(null); } // vanished between the two stats
  }
  return out;
}

/** A video's poster frame, at player size rather than tile size. QuickLook is what Finder uses, so
 *  the frame it picks is the one the user already recognises the file by. Null is normal — the
 *  player falls back to its own placeholder and the first decoded frame replaces it anyway. */
const POSTER_PX = 640;
export function mediaPoster(home: string, path: string): Promise<string | null> {
  return quickLookThumbnail(home, path, POSTER_PX);
}

/** Called BEFORE `app.ready` — Electron requires privileged schemes to be declared that early.
 *  `stream: true` is what admits Range requests, and so seeking; `secure` keeps the scheme out of
 *  mixed-content downgrades. `supportFetchAPI` is deliberately NOT set: nothing fetches a media URL,
 *  the elements load them, and the page's `connect-src` does not admit the scheme anyway — declaring
 *  a capability the CSP refuses would only be a lie in the privilege table. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, stream: true, bypassCSP: false },
  }]);
}

/** Called after `app.ready`. Every refusal is a 404 rather than an error: a media element handed a
 *  path that has since moved should fall back to its poster, not raise. */
export function handleMediaProtocol(home = homedir()): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const candidate = pathFromMediaUrl(request.url);
    const path = candidate === null ? null : await servablePath(candidate, home);
    if (!path) return new Response(null, { status: 404 });
    // `net.fetch` on a file: URL is what makes this a STREAM rather than a buffer — it forwards the
    // request's Range header and answers 206 with the slice, which is the whole point of the scheme.
    return net.fetch(pathToFileURL(path).toString(), { headers: request.headers });
  });
}
