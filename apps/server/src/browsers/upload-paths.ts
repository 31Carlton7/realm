/**
 * What a `browser_upload` path has to survive before the user is even asked (Plan 26).
 *
 * This is the file that decides which bytes on this Mac a web page may be given, and it runs
 * ENTIRELY before the permission card — the card's job is to describe a decision, not to be the only
 * thing standing behind one. The order matters and each step answers a different question:
 *
 *   1. **Does it exist, and is it a file?** A path that does not resolve is an agent mistake, and it
 *      should read as one rather than as a permission problem.
 *   2. **What is it REALLY?** Every path is `realpath`'d. Containment and the secret-path rules are
 *      then applied to the resolved path, so `~/space/key -> ~/.ssh/id_rsa` is refused by its true
 *      name and a file reached through `/tmp` (a symlink to `/private/tmp` on macOS) is not wrongly
 *      called an escape.
 *   3. **Is it a secret?** `uploadPathRefusal` — a REFUSAL, not a second prompt. No approval
 *      licenses `~/.ssh/id_rsa`, and the message names the path so the agent stops rather than
 *      retrying its way around.
 *   4. **Is it inside the space folder?** Inside is the default root and needs nothing more. Outside
 *      is allowed but must be VISIBLE: the full resolved path goes on the card, quoted, and the user
 *      approves that specific path or nothing happens.
 *
 * The resolved path is what travels to Electron main, and main opens exactly that — so the string
 * the user approved and the string Chromium reads are the same string, with no second resolution in
 * between for a symlink to change under.
 */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, basename } from "node:path";
import {
  UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES, formatUploadSize, isUnderRoot, uploadPathRefusal,
  type BrowserUploadFile,
} from "@realm/contracts";

/** One vetted file, plus whether the user is being asked to reach outside the space folder for it. */
export type ResolvedUploadFile = BrowserUploadFile & {
  /** The path as the agent wrote it, kept only so an error can quote what was asked for. */
  requested: string;
  /** True when `path` resolved outside the space folder — the card quotes it in full. */
  outsideRoot: boolean;
};

export type ResolveUploadResult =
  | { ok: true; files: ResolvedUploadFile[] }
  | { ok: false; error: string };

/**
 * Resolve and vet every path in one call. All-or-nothing: a batch with one bad path resolves to an
 * error naming that path, and nothing is uploaded.
 *
 * All-or-nothing rather than best-effort because the card is per CALL. "Upload these five images"
 * approved against a list of five must not become an upload of four — the user answered a question
 * about a set, and silently shrinking the set answers a question they were not asked.
 */
export async function resolveUploadPaths(paths: readonly string[], root: string | null): Promise<ResolveUploadResult> {
  if (paths.length === 0) return { ok: false, error: "no paths were given — pass the absolute path of each file to attach." };
  if (paths.length > UPLOAD_MAX_FILES) {
    return { ok: false, error: `that is ${paths.length} files; one upload carries at most ${UPLOAD_MAX_FILES}. Split it into several calls — each gets its own approval.` };
  }

  // The root is resolved ONCE, and through the same realpath the files go through. Comparing a
  // resolved file against an unresolved root is how a space folder reached by a symlink reports
  // every one of its own files as outside itself.
  const realRoot = root === null ? null : await realpath(root).catch(() => root);

  const files: ResolvedUploadFile[] = [];
  const seen = new Set<string>();
  for (const requested of paths) {
    /*
     * The secret rules run against the path AS WRITTEN before anything else — before absoluteness,
     * before `realpath`. `~/.ssh/id_rsa` does not resolve (the shell expands `~`, and nothing here is
     * a shell), so without this it would come back as "not an absolute path" and read like a syntax
     * correction to retry. It is not one. The answer to a private key is the same answer whichever
     * way it was spelled, and the resolved path is checked again below for the spellings that do
     * resolve.
     */
    const asWritten = uploadPathRefusal(requested);
    if (asWritten) return { ok: false, error: asWritten };
    if (!isAbsolute(requested)) {
      return { ok: false, error: `"${requested}" is not an absolute path. browser_upload takes absolute paths on this machine — relative ones would resolve against a directory you cannot see.` };
    }
    if (requested.includes("\0")) return { ok: false, error: "a path contained a null byte." };

    let path: string;
    try {
      path = await realpath(requested);
    } catch {
      return { ok: false, error: `no such file: ${requested}` };
    }

    // Secrets first, before anything else is said about the file — including before its size, which
    // is itself a fact about a key nobody needs stated.
    const refusal = uploadPathRefusal(path);
    if (refusal) return { ok: false, error: refusal };

    let size: number;
    try {
      const st = await stat(path);
      if (!st.isFile()) return { ok: false, error: `${requested} is not a file (it is a directory or a device) — a page takes files.` };
      size = st.size;
    } catch {
      return { ok: false, error: `no such file: ${requested}` };
    }
    if (size > UPLOAD_MAX_BYTES) {
      return { ok: false, error: `${basename(path)} is ${formatUploadSize(size)}, over Realm's ${formatUploadSize(UPLOAD_MAX_BYTES)} upload limit.` };
    }
    if (seen.has(path)) return { ok: false, error: `${requested} was listed twice — a page would receive it twice.` };
    seen.add(path);

    files.push({
      path,
      // The NAME the page will see, taken from the resolved path. A symlinked `photo.png` pointing
      // at `IMG_0042.HEIC` uploads under the name of what it actually is, because that name is what
      // `accept` is checked against and what the site records.
      name: basename(path),
      bytes: size,
      requested,
      outsideRoot: realRoot === null ? true : !isUnderRoot(realRoot, path),
    });
  }
  return { ok: true, files };
}
