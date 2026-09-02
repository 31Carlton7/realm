import { isAbsolute, relative, resolve, sep } from "node:path";
import { RpcError } from "../store/rows";

/**
 * Resolve a client-supplied RELATIVE path against a workspace root, refusing anything that lands
 * outside it.
 *
 * **Stance, stated plainly:** this is a correctness guardrail, not a security boundary — the same
 * posture Plan 11 took for the browser's origin allowlist. Every agent in Realm already has shell and
 * filesystem access through its own tools, and the RPC socket is loopback-only, so nothing here is
 * holding back a determined caller. What it does hold back is the ordinary bug: a `..` that slipped
 * into a stored tab, a client that sent an absolute path because it had one lying around, a stale
 * workspace pointed at a deleted worktree. Those turn into a clear error instead of the pane quietly
 * editing `~/.ssh/config`.
 *
 * Symlinks are deliberately NOT resolved. A checkout containing a symlinked `docs/` directory is a
 * normal thing that must keep working, and following links would only move the boundary rather than
 * close it (the caller can already read that target by other means). Containment is therefore logical:
 * it is about the shape of the path, not about the inode it lands on.
 */
export function resolveInRoot(root: string, rel: string): string {
  if (rel.includes("\0")) throw new RpcError("BAD_PATH", "path contains a null byte");
  // An absolute path from a client is never legitimate here — `openPaths` is a relative-path contract.
  // Caught explicitly rather than left to the containment check below, which would also reject it but
  // with a message that sends the reader looking for a traversal that is not there.
  if (isAbsolute(rel)) throw new RpcError("BAD_PATH", `path must be relative to the workspace root: ${rel}`);
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new RpcError("BAD_PATH", `path escapes the workspace root: ${rel}`);
  }
  return abs;
}

/**
 * The inverse, for the watcher: an absolute path back to the `/`-separated relative form the tab strip
 * and `documents.fileChanged` speak. Returns null when the path is outside the root, which is how the
 * watcher drops events for files it should never have been told about.
 */
export function relInRoot(root: string, abs: string): string | null {
  const rootAbs = resolve(root);
  const target = resolve(abs);
  if (target === rootAbs) return "";
  if (!target.startsWith(rootAbs + sep)) return null;
  return relative(rootAbs, target).split(sep).join("/");
}
