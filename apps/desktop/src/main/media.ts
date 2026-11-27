import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { protocol } from "electron";
import {
  BACKGROUND_SCHEME, MEDIA_SCHEME, expandHome, isImageMime, isPlayablePath, mediaKindFor, mimeForPath, pathFromMediaUrl, spaceImageFromMediaUrl,
  type MediaFile,
} from "@realm/contracts";
import { quickLookThumbnail } from "./attachments";
import { backgroundLoopFile } from "./backgrounds";

/**
 * Serving local media to the renderer.
 *
 * The renderer has no filesystem access and the page's CSP refuses `file://`, so a picture or a
 * movie on disk can only be NAMED there unless something carries the bytes across. `attachment-
 * thumbnail` does that for a 96px tile by minting a data: URL, and that approach does not scale to
 * a video: base64 is a third larger than the file, it arrives in one piece, and an element handed
 * one cannot seek. `realm-media://` is the streaming answer: it answers Range requests itself
 * (`serveFile`), so the player starts on the first frame and scrubbing works.
 *
 * The gate is deliberately narrow and lives in ONE function (`servablePath`): the path must resolve
 * to a real file whose extension maps to an image, video or audio mime. Everything else — source,
 * config, a `.env` — has no mime in Realm's table that `mediaKindFor` accepts, so it can never be
 * fetched through this scheme however the URL is spelled.
 */

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

const isInside = (folder: string, path: string): boolean => path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
const isImagePath = (path: string): boolean => isImageMime(mimeForPath(path));

/**
 * The picture a Markdown document in a space shows by relative path (`![x](pic.png)`), or null.
 *
 * Narrower than `servablePath`, because what names the file here is the document, and a document is
 * whatever an agent or a download wrote: it reaches pictures only, and only under the space folder.
 * Both are checked on the collapsed string and again on the real paths, so neither a `../` nor a
 * link inside the space pointing out of it gets past.
 */
export async function spaceImagePath(root: string, path: string): Promise<string | null> {
  if (!isAbsolute(root)) return null;
  const folder = resolve(root);
  const file = resolve(folder, path);
  if (!isInside(folder, file) || !isImagePath(file)) return null;
  try {
    const [realFolder, realFile] = await Promise.all([realpath(folder), realpath(file)]);
    if (!isInside(realFolder, realFile) || !isImagePath(realFile)) return null;
    if (!(await stat(realFile)).isFile()) return null;
    return file;
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
 *  a capability the CSP refuses would only be a lie in the privilege table.
 *
 *  The backgrounds' loops (backgrounds.ts) are declared in the same call, because only the last call
 *  is honoured; theirs is `corsEnabled`, since a loop is drawn into WebGL. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, bypassCSP: false } },
    { scheme: BACKGROUND_SCHEME, privileges: { standard: true, secure: true, stream: true, corsEnabled: true, bypassCSP: false } },
  ]);
}

/**
 * One file as an HTTP answer, honouring a `Range` header the way a media element expects: the whole
 * file (200) when none is asked for, the slice with its `Content-Range` (206) when one is, and 416
 * for a range past the end.
 *
 * Done here rather than left to `net.fetch` on a `file://` URL, whose handling of a forwarded Range
 * header is Electron's to change between versions: a seek is only as good as the 206 behind it, and a
 * `.mov` whose index sits at the end of the file cannot even start without one.
 */
export async function serveFile(path: string, range: string | null, extra: Record<string, string> = {}): Promise<Response> {
  const { size } = await stat(path);
  const headers = { "Content-Type": mimeForPath(path), "Accept-Ranges": "bytes", ...extra };
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m || (m[1] === "" && m[2] === "")) {
    return new Response(size === 0 ? null : body(path, 0, size - 1), { status: 200, headers: { ...headers, "Content-Length": String(size) } });
  }
  // `bytes=-500` is the last 500 bytes; `bytes=500-` runs to the end.
  const start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  }
  return new Response(body(path, start, end), {
    status: 206,
    headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
  });
}

const body = (path: string, start: number, end: number): ReadableStream =>
  Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;

/** Called after `app.ready`. Every refusal is a 404 rather than an error: a media element handed a
 *  path that has since moved should fall back to its poster, not raise. */
export function handleMediaProtocol(home = homedir()): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const inSpace = spaceImageFromMediaUrl(request.url);
    const candidate = pathFromMediaUrl(request.url);
    const path = inSpace ? await spaceImagePath(inSpace.root, inSpace.path)
      : candidate === null ? null : await servablePath(candidate, home);
    if (!path) return new Response(null, { status: 404 });
    try { return await serveFile(path, request.headers.get("range")); } catch { return new Response(null, { status: 404 }); }
  });
}

/**
 * `realm-background://loop/<id>`: the loop of one of the person's own backgrounds, looked up by id in
 * their index and nothing else. It says any page may read it, because WebGL refuses a cross-origin
 * video that does not, and the renderer's page has an opaque origin under file://. What it can serve
 * is only ever a file the person added as a background.
 */
export function handleBackgroundProtocol(home: string): void {
  protocol.handle(BACKGROUND_SCHEME, async (request) => {
    const url = new URL(request.url);
    const kept = url.hostname === "loop" ? await backgroundLoopFile(home, url.pathname.slice(1)) : null;
    if (!kept) return new Response(null, { status: 404 });
    try { return await serveFile(kept.path, request.headers.get("range"), { "Access-Control-Allow-Origin": "*" }); } catch { return new Response(null, { status: 404 }); }
  });
}
