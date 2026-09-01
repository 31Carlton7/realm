import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * Where each agent CLI keeps the things this feature reads. Every one is READ-ONLY to Realm — see
 * `packages/contracts/src/import.ts` for the rule and why it is not negotiable.
 *
 * All of them are overridable as a unit (`ImportRoots`), which is what lets the tests run against a
 * fixture tree instead of the developer's own `~/.claude`. There is no partial override: a test that
 * set three of four roots and inherited the fourth would silently read the real home directory, which
 * is exactly the accident the space's standing rule about scratch homes exists to prevent.
 */
export type ImportRoots = {
  /** `~/.claude` — `projects/<slug>/*.jsonl` transcripts, `projects/<slug>/memory/` docs, `skills/`. */
  claude: string;
  /** `~/.codex` — `sessions/YYYY/MM/DD/rollout-*.jsonl`, `skills/`. */
  codex: string;
  /** `~/.cursor` — `acp-sessions/<id>/store.db`, `chats/<hash>/<id>/store.db`, `skills/`. */
  cursor: string;
  /** Skill folders belonging to no single CLI: `~/.agents/skills` (the cross-agent convention) and
   *  `~/.gemini/skills`. Sessions are not read from these; only skills. */
  extraSkillDirs: string[];
};

export function defaultRoots(home = homedir()): ImportRoots {
  const at = (...parts: string[]) => resolve(home, ...parts);
  return {
    // The CLI's own override wins, exactly as `claudeUserDir()` honours it for the memory pane — a
    // user who moved their Claude config would otherwise get an empty scan with no explanation.
    claude: process.env.CLAUDE_CONFIG_DIR || at(".claude"),
    codex: process.env.CODEX_HOME || at(".codex"),
    cursor: at(".cursor"),
    extraSkillDirs: [at(".agents", "skills"), at(".gemini", "skills"), at(".cursor", "skills")],
  };
}

/**
 * Directory prefixes whose contents are scratch: temp trees, and the per-run checkouts Realm's own
 * live checks and tests build inside them.
 *
 * `/private` is listed alongside `/tmp` and `/var` because macOS resolves both to the same place and
 * the transcripts record whichever form the process happened to hold — a filter that knew only one
 * would let half the noise through.
 */
const SCRATCH_PREFIXES = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/var/tmp", "/private/var/tmp"];

/** Whether a recorded cwd is a scratch directory rather than somewhere the user works. Path-shaped,
 *  not content-shaped: it asks where the session ran, never what it said. */
export function isScratchPath(cwd: string, tmp = tmpdir()): boolean {
  if (!cwd || !isAbsolute(cwd)) return true; // no usable cwd at all — nothing to match a space on
  const p = resolve(cwd);
  const under = (prefix: string) => p === prefix || p.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);
  return [...SCRATCH_PREFIXES, resolve(tmp)].some(under);
}

/**
 * Claude's project-directory names are a lossy encoding of the cwd: every `/` becomes `-`, and so
 * does every `-` that was already in the path. `-Users-carltonaikins-Desktop-Home-Work-Projects-realm`
 * could decode to `/Users/.../Projects/realm` or `/Users/.../Projects-realm`, and nothing in the name
 * says which.
 *
 * So this is NOT used to determine a session's cwd — the transcript records the real one on every
 * line, and that is what the parser reads. This exists only for the memory folders, which sit beside
 * the transcripts and carry no cwd of their own: the decode is checked against the filesystem
 * (`existsSync`), and an ambiguous name that resolves to nothing real degrades to the raw slug rather
 * than to a confident wrong path.
 */
export function decodeClaudeProjectSlug(slug: string, childrenOf: (dir: string) => string[]): string | null {
  if (!slug.startsWith("-")) return null;
  const parts = slug.slice(1).split("-");
  // Resolved against the real directory tree, one level at a time, LONGEST RUN FIRST: at each level
  // the actual children are listed and the longest run of remaining parts that names one of them is
  // taken as that segment.
  //
  // Longest-first is what makes it correct. A shortest-first (or "try `/` then `-`") walk commits to
  // `School/SP26` — which does not exist — before it can discover that the real child is
  // `SP26-EE-451`, and then no continuation can recover. Listing the directory removes the guesswork
  // entirely: `School` has exactly one child matching a run, and it is found in one pass.
  let path = "";
  for (let i = 0; i < parts.length;) {
    const children = new Set(childrenOf(path === "" ? "/" : path));
    let taken = -1;
    for (let j = parts.length - 1; j >= i; j--) {
      if (children.has(parts.slice(i, j + 1).join("-"))) { taken = j; break; }
    }
    if (taken === -1) return null; // nothing here matches: the slug names a directory that is gone
    path = `${path}/${parts.slice(i, taken + 1).join("-")}`;
    i = taken + 1;
  }
  return path;
}
