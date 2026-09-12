import { createHash } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DOCUMENT_MAX_BYTES } from "@realm/contracts";
import { RpcError } from "../store/rows";

/**
 * The content identity every save and every watch event is compared on. Truncated to 64 bits, which is
 * ample: this answers "is this the same text I last saw", not "could an adversary forge a collision".
 */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Realm's atomic-save temp files. Named so the watcher can recognise and ignore its own churn. */
const TMP_PREFIX = ".realm-tmp-";
export const isTempArtifact = (name: string): boolean => basename(name).startsWith(TMP_PREFIX);

export type ReadResult = { text: string; hash: string };

/**
 * How much of a file the text check looks at. git uses the first 8000 bytes for the same decision and
 * has been right about it for twenty years; a file whose first 8 kB are clean text and whose middle is
 * a PNG is not a case worth paying a whole-file scan on every open for.
 */
export const TEXT_SNIFF_BYTES = 8192;

/**
 * Why a file must not be handed to a text editor, or null when it may be.
 *
 * Two different refusals, because they are two different facts and they deserve two different
 * sentences:
 *
 * - **`binary`** — a NUL byte in the head. This is git's own rule and it catches images, archives,
 *   compiled output and anything else whose bytes are not characters at all. Opening one produces a
 *   pane full of replacement characters and a save that destroys the file.
 * - **`not-utf8`** — no NUL, but the bytes are not valid UTF-8 (a Latin-1 or Shift-JIS source file,
 *   say). This IS text, and saying otherwise would be a lie. It is still refused, and for exactly the
 *   reason `baseHash` exists: Realm reads and writes UTF-8, so every byte the decoder could not
 *   understand comes back as U+FFFD and the first save silently rewrites the file with the original
 *   characters gone. A refusal the user can act on beats a corruption they find out about later.
 *
 * STREAM mode is used only when the head was actually CUT — a multi-byte character straddling byte
 * 8192 is then held back rather than reported as invalid, which otherwise called every file with an
 * emoji near that offset binary in whichever fraction of cases the split landed mid-character. A file
 * short enough to have been read whole is decoded without it, so a genuinely truncated sequence at
 * the end of a small file is still caught.
 */
export type TextRefusal = "binary" | "not-utf8" | null;

export function textRefusal(bytes: Buffer): TextRefusal {
  const head = bytes.subarray(0, TEXT_SNIFF_BYTES);
  if (head.includes(0)) return "binary";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: bytes.length > TEXT_SNIFF_BYTES });
    return null;
  } catch {
    return "not-utf8";
  }
}

/**
 * Read a document, refusing anything past the editable ceiling.
 *
 * The size is checked by `stat` BEFORE the read, not by measuring the string afterwards: the point of
 * the cap is to avoid pulling a 40 MB file into memory at all, and a check that reads first has
 * already paid the cost it exists to avoid.
 *
 * `refuseBinary` is off by default and the default is the load-bearing part. Most callers here are
 * asking "what is currently on disk" so they can compare a hash or check existence — `writeDocument`,
 * `renameDocument`, the guide sidecar — and a rename onto an existing PNG must fail with "already
 * exists", which is what the caller asked about, rather than with "that file is binary", which it did
 * not. Only the path that puts bytes in front of a person turns it on.
 */
export async function readDocument(abs: string, o: { refuseBinary?: boolean } = {}): Promise<ReadResult> {
  const st = await stat(abs);
  if (st.isDirectory()) throw new RpcError("BAD_PATH", `${abs} is a directory`);
  if (st.size > DOCUMENT_MAX_BYTES) {
    throw new RpcError("TOO_LARGE", `file is ${st.size} bytes; the document pane opens up to ${DOCUMENT_MAX_BYTES}`);
  }
  if (!o.refuseBinary) return textOf(await readFile(abs, "utf8"));
  const bytes = await readFile(abs);
  const refusal = textRefusal(bytes);
  if (refusal === "binary") throw new RpcError("BINARY", `${basename(abs)} is a binary file, not text`);
  if (refusal === "not-utf8") throw new RpcError("NOT_UTF8", `${basename(abs)} is not UTF-8; Realm would rewrite it on save`);
  return textOf(bytes.toString("utf8"));
}

const textOf = (text: string): ReadResult => ({ text, hash: hashText(text) });

/** `null` when the file does not exist — the caller distinguishes "absent" from "empty". */
export async function readIfExists(abs: string): Promise<ReadResult | null> {
  try { return await readDocument(abs); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export type WriteOutcome =
  | { ok: true; hash: string }
  | { ok: false; currentText: string; currentHash: string };

/**
 * Save, guarded against lost updates.
 *
 * `baseHash` is what the caller believes is currently on disk — the hash it last read or last wrote.
 * The write proceeds only if disk still agrees. This is the check that stops an agent's edit and the
 * user's unsaved paragraph from destroying one another; without it, whichever of the two saves last
 * silently wins and the other's work is gone with no trace and no undo.
 *
 * Two asymmetric cases, both deliberate:
 *
 * - **`baseHash === null` (first save of a new document) but the file exists.** Refused. Something
 *   created it between the pane opening its empty buffer and this save, and overwriting would destroy
 *   content the user has never seen.
 * - **`baseHash` set but the file is gone.** Allowed, and re-creates it. A document deleted underneath
 *   an open editor leaves the tab stale-but-open by design, and saving is exactly how the user rescues
 *   their buffer. Refusing here would mean the only copy of the text is in a pane that cannot save it.
 */
export async function writeDocument(abs: string, text: string, baseHash: string | null): Promise<WriteOutcome> {
  const current = await readIfExists(abs);
  if (current === null) {
    // Gone (or never existed). Either way this write creates it; see the doc comment.
  } else if (baseHash === null) {
    return { ok: false, currentText: current.text, currentHash: current.hash };
  } else if (current.hash !== baseHash) {
    return { ok: false, currentText: current.text, currentHash: current.hash };
  }
  await writeAtomic(abs, text);
  return { ok: true, hash: hashText(text) };
}

/**
 * Move a document, refusing to land on a file that already exists.
 *
 * `rename(2)` overwrites its destination silently, which for a user-facing rename is the wrong
 * default by a wide margin: typing the name of a document you already have would destroy it with no
 * prompt and no undo. The existence check is not atomic — nothing on a POSIX filesystem gives you
 * "rename unless the target exists" in one call — but the race it leaves is two renames onto the same
 * name in the same millisecond, which is not a thing a person does.
 */
export async function renameDocument(absFrom: string, absTo: string): Promise<void> {
  if (absFrom === absTo) return;
  if (await readIfExists(absTo)) throw new RpcError("EXISTS", `${absTo} already exists`);
  try {
    await stat(absTo);
    throw new RpcError("EXISTS", `${absTo} already exists`); // a directory, or a file too big to read
  } catch (e) {
    if (e instanceof RpcError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await rename(absFrom, absTo);
}

/**
 * Write via temp file + rename, so a crash mid-save can never leave a half-written document. The
 * rename is why the watcher watches DIRECTORIES rather than files: an `fs.watch` bound to the original
 * file's inode goes deaf the moment that inode is replaced, which is every single save.
 */
export async function writeAtomic(abs: string, text: string): Promise<void> {
  const tmp = join(dirname(abs), `${TMP_PREFIX}${process.pid}-${Date.now().toString(36)}-${basename(abs)}`);
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, abs);
  } catch (e) {
    // Best-effort cleanup; a leftover temp file is noise, but throwing from the cleanup would mask
    // the real failure the caller needs to see.
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
