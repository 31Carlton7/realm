import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The `CLAUDE.md` hierarchy, modeled by READING the same paths the CLI reads — never writing them.
 *
 * The CLI's own load order (spec §1.3): `~/.claude/CLAUDE.md`, then `CLAUDE.md` / `.claude/CLAUDE.md` /
 * `CLAUDE.local.md` per ancestor directory of cwd, root-most first, with `@path` imports resolved from
 * the file that names them (max 4 hops, skipped inside code fences). Claude reports nothing back about
 * what it loaded — there is no `instructionSources` equivalent — so this model is as close to ground
 * truth as the Claude side gets, and it is built from the identical paths rather than a guess.
 */
export type ClaudeMemoryFile = {
  path: string;
  origin: "user" | "project" | "import";
  exists: boolean;
  /** File text, capped at MAX_FILE_CHARS. Null when the file is absent or unreadable. */
  content: string | null;
};

/** The CLI's own import limit: "max 4 hops". */
const MAX_IMPORT_HOPS = 4;
/** A memory file is prose measured in KB; anything bigger is truncated rather than allowed to swallow
 *  a prompt. The pane still lists the file — `exists` is about the file, not the cap. */
const MAX_FILE_CHARS = 256 * 1024;

/** The directory the CLI itself reads user config from: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
export function claudeUserDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function readCapped(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > MAX_FILE_CHARS ? text.slice(0, MAX_FILE_CHARS) : text;
  } catch {
    return null;
  }
}

/**
 * `@path` import references, the way the CLI finds them: preceded by start-of-line or whitespace
 * (so `user@example.com` is not an import), running to the next whitespace, and ignored inside
 * ``` / ~~~ fenced blocks. Prose that happens to start a word with `@` yields a path that does not
 * exist, which the caller drops — same net behavior as the CLI trying and failing to read it.
 */
export function parseImports(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    const t = line.trimStart();
    if (t.startsWith("```") || t.startsWith("~~~")) { fenced = !fenced; continue; }
    if (fenced) continue;
    for (const m of line.matchAll(/(?:^|\s)@([^\s@]+)/g)) out.push(m[1]!);
  }
  return out;
}

function resolveImport(spec: string, fromDir: string): string {
  if (spec.startsWith("~/")) return join(homedir(), spec.slice(2));
  if (isAbsolute(spec)) return spec;
  return resolve(fromDir, spec);
}

/**
 * Every memory file a Claude session at `cwd` loads (or would), in the CLI's own order.
 *
 * The two well-known locations — the user file and `<cwd>/CLAUDE.md` — are listed even when absent,
 * because the pane's job includes showing where a file WOULD go. Ancestor, `.claude/` and `.local`
 * variants plus imports appear only when they exist; listing every absent candidate up the tree would
 * bury the real rows.
 */
export function claudeMemoryFiles(cwd: string, userDir = claudeUserDir()): ClaudeMemoryFile[] {
  const out: ClaudeMemoryFile[] = [];
  const seen = new Set<string>();
  const push = (path: string, origin: ClaudeMemoryFile["origin"], listAbsent: boolean, hop: number): void => {
    if (seen.has(path)) return; // also what makes an import cycle terminate
    seen.add(path);
    const content = readCapped(path);
    if (content === null && !listAbsent) return;
    out.push({ path, origin, exists: content !== null, content });
    if (content === null || hop >= MAX_IMPORT_HOPS) return;
    for (const spec of parseImports(content)) push(resolveImport(spec, dirname(path)), "import", false, hop + 1);
  };

  push(join(userDir, "CLAUDE.md"), "user", true, 0);

  const top = resolve(cwd);
  const dirs: string[] = [];
  for (let dir = top; ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dirname(dir) === dir) break;
  }
  for (const dir of dirs) {
    push(join(dir, "CLAUDE.md"), "project", dir === top, 0);
    push(join(dir, ".claude", "CLAUDE.md"), "project", false, 0);
    push(join(dir, "CLAUDE.local.md"), "project", false, 0);
  }
  return out;
}
