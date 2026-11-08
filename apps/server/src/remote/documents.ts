import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, sep } from "node:path";
import { documentKindFor, isSecretPath, mimeForPath } from "@realm/contracts";
import type { MobileResult } from "@realm/remote";
import { HIDDEN_DIRS } from "../documents/paths";
import { PreviewRefused } from "./preview";

/**
 * What a phone may read of a space's folder (`documents.*`). The pane's own path check is a guardrail
 * against a confused client on this Mac (`documents/paths.ts`); a phone is on the other side of a
 * network, so here a link is followed before it is believed, and what it lands on must still be in the
 * folder and must not hold a secret.
 */

export const SECRET_REFUSAL = "That file holds a secret, so Realm does not send it to a phone.";
const OUTSIDE_REFUSAL = "That file is not in this space's folder.";
const HIDDEN_REFUSAL = "Realm does not show what is in that folder.";

export const DOCUMENTS_SEARCH_LIMIT = 50;

type Row = MobileResult<"documents.list">["entries"][number];

const isUnder = (root: string, path: string) => path === root || path.startsWith(root + sep);

/** `path` in the folder at `root` as a full path, or a refusal. "" is the folder itself. */
export async function checkSpacePath(root: string, path: string): Promise<string> {
  const parts = path.split("/");
  if (path.includes("\0") || isAbsolute(path) || parts.includes("..")) throw new PreviewRefused(OUTSIDE_REFUSAL);
  if (parts.some((part) => HIDDEN_DIRS.has(part))) throw new PreviewRefused(HIDDEN_REFUSAL);
  if (isSecretPath(path)) throw new PreviewRefused(SECRET_REFUSAL);
  const abs = join(root, path);
  const landed = await realpath(abs);
  if (!isUnder(await realpath(root), landed)) throw new PreviewRefused(OUTSIDE_REFUSAL);
  if (landed !== abs && isSecretPath(landed)) throw new PreviewRefused(SECRET_REFUSAL);
  return abs;
}

/** The row for `path`, or null for what a read of it would refuse, or a file gone since it was listed. */
export async function documentRow(root: string, path: string, isDir: boolean): Promise<Row | null> {
  try {
    const abs = await checkSpacePath(root, path);
    const s = await lstat(abs);
    // `session.file`'s rule for a file: a link could point anywhere. A linked folder is a normal thing.
    if (s.isSymbolicLink() && !isDir) return null;
    return { path, name: basename(path), isDir, size: isDir ? 0 : s.size, kind: isDir ? "folder" : documentKindFor(path), mime: isDir ? "" : mimeForPath(path) };
  } catch {
    return null;
  }
}

/** The file `query` names exactly, as a path in the folder or as the name of a file search found, where
 *  that file holds a secret. Nothing else is said of a secret: a near match stays unlisted. */
export async function withheldFile(root: string, query: string, found: readonly string[]): Promise<Row | null> {
  const named = [query, ...found.filter((path) => basename(path) === query)];
  for (const path of named) {
    if (!isSecretPath(path) || isAbsolute(path) || path.split("/").includes("..")) continue;
    const s = await lstat(join(root, path)).catch(() => null);
    if (s) return { path, name: basename(path), isDir: false, size: s.size, kind: documentKindFor(path), mime: mimeForPath(path) };
  }
  return null;
}
