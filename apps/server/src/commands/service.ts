import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  COMMAND_HEAD_BYTES, commandKey, commandNameFromFile, expandCommand, readCommandDocument, runnableCommands,
  type CommandDocument, type CommandMeta, type CommandOrigin, type UserCommand,
} from "@realm/contracts";
import { tildify } from "../skills/discovery";
import { parseSkillDocument } from "../skills/frontmatter";
import { claudeUserDir } from "../memory/claude-files";
import { NotFoundError, RpcError } from "../store/rows";

/** Realm's own command folder. `<REALM_HOME>/commands`, beside `<REALM_HOME>/skills`, because the two
 *  are the same gesture — drop a Markdown file in a folder and the app picks it up. */
export const commandsRoot = (home: string): string => join(home, "commands");

/**
 * User-defined slash commands: prompt templates on disk, discovered the way skills are.
 *
 * The source model is deliberately the skills one (`skills/service.ts`) rather than a second
 * invention — same precedence-ordered roots, same "Realm reads other agents' directories and never
 * writes them" promise, same insistence that a file it cannot parse is LISTED with a reason instead
 * of vanishing. A user who has understood one has understood the other.
 *
 * Everything reads the filesystem on demand, for the reason `SkillsService` gives: these are folders
 * the user opens in Finder, so a cache could only ever be a way to be wrong about them. There is not
 * even the parse memo `SkillsService` keeps — that exists because a hundred `SKILL.md` files are read
 * once per space in a search loop; a space has a handful of commands and reads them when a picker opens.
 *
 * `cwd` is the session's working folder, for the repo's own `.claude/commands`. Null outside a
 * session (the palette), which simply drops that root.
 */
export class UserCommandsService {
  readonly root: string;
  private readonly claudeDir: string;
  private readonly userHome: string;
  constructor(private d: {
    /** REALM_HOME. Note this is NOT the OS home: `~/.claude` is found through `claudeDir` below,
     *  which is what keeps `<REALM_HOME>/commands` and `~/.claude/commands` two different places
     *  even when REALM_HOME has been pointed somewhere unusual. */
    home: string;
    /** Where `~/.claude` is, same override `MemoryService` takes (and the same `CLAUDE_CONFIG_DIR`
     *  honouring, since both go through `claudeUserDir`). Tests point it at a fixture. */
    claudeDir?: string;
    /** Only for tildifying labels. A label is the one thing here that is about the person, not the
     *  machine, and `~/Realm/commands` reads better than four inches of absolute path. */
    userHome?: string;
    /** The space's own folder, for its `commands/` directory. Optional on the same terms as
     *  `SkillsService.spaces`: unwired, every space simply contributes no space-level commands, which
     *  is never a reason to fail a list. */
    spaces?: { folderPathOf(spaceId: string): string | null };
  }) {
    this.root = commandsRoot(d.home);
    this.claudeDir = d.claudeDir ?? claudeUserDir();
    this.userHome = d.userHome ?? homedir();
  }

  /**
   * Every directory scanned for this space, in precedence order.
   *
   * Realm's own two roots are listed whether or not they exist; the agent's is listed only when it
   * does. The asymmetry is the one `skills/discovery.ts` already draws: a folder Realm owns is where
   * the user is being TOLD to put commands (and "I made that folder and nothing appeared" is the
   * question a listed empty root answers), while inventing `~/.claude/commands` for someone who does
   * not use Claude would show them a directory Realm made up.
   */
  roots(spaceId: string | null, cwd: string | null = null): CommandOrigin[] {
    const out: CommandOrigin[] = [];
    const folder = spaceId ? this.d.spaces?.folderPathOf(spaceId) ?? null : null;
    if (folder) out.push({ kind: "space", key: "space", label: `${basename(folder)}/commands`, root: join(folder, "commands"), writable: true });
    // One agent dialect, deliberately: Claude's — frontmatter `description`/`argument-hint`,
    // `$ARGUMENTS`, `$ARGUMENTS[N]` and `$N` — which is the whole reason a discovered file can be
    // expanded at all. Codex's `~/.codex/prompts` is not read: codex-cli 0.169 no longer has it.
    const claude = join(this.claudeDir, "commands");
    // A session in the home folder would list `~/.claude/commands` twice, once under each label.
    const project = cwd ? join(cwd, ".claude", "commands") : null;
    if (project && resolve(project) !== resolve(claude) && isDir(project)) {
      out.push({ kind: "project", key: "project", label: `${basename(cwd!)}/.claude/commands`, root: project, writable: false });
    }
    out.push({ kind: "user", key: "user", label: tildify(this.root, this.userHome), root: this.root, writable: true });
    if (isDir(claude)) out.push({ kind: "agent", key: "claude", label: tildify(claude, this.userHome), root: claude, writable: false });
    return out;
  }

  /**
   * Every command file visible to this space, sorted by name, winner of each name first.
   *
   * **Only a runnable file takes a name.** A `commands/test.md` in the repo with no `description` does
   * not shadow the user's working `/test`: it is listed with its reason and the name falls through to
   * the next source. The other rule — first file wins, broken or not — would let a typo in a file
   * someone else committed silently disable a command the user has been running for months.
   *
   * The sort relies on `Array.prototype.sort` being stable (ES2019 on): roots are walked in
   * precedence order, so equal names come out winner-first without carrying an index around.
   */
  list(spaceId: string | null, cwd: string | null = null): { root: string; commands: UserCommand[] } {
    const winners = new Map<string, string>();
    const commands: UserCommand[] = [];
    for (const origin of this.roots(spaceId, cwd)) {
      for (const file of files(origin.root)) {
        const name = commandNameFromFile(file);
        if (!name) continue;
        const path = join(origin.root, file);
        const meta = readMeta(path, name);
        const key = commandKey(name);
        const shadowedBy = winners.get(key) ?? null;
        if (meta.valid && !shadowedBy) winners.set(key, path);
        commands.push({ name, ...meta, path, origin, shadowedBy });
      }
    }
    return { root: this.root, commands: commands.sort((a, b) => commandKey(a.name).localeCompare(commandKey(b.name))) };
  }

  /** The commands `/name` would actually run, for the prompter's picker. */
  runnable(spaceId: string | null, cwd: string | null = null): UserCommand[] {
    return runnableCommands(this.list(spaceId, cwd).commands);
  }

  /**
   * Expand one command against what the user typed after it.
   *
   * A name that exists but cannot run is refused with the file's OWN reason rather than a bare
   * NOT_FOUND — "no such command" would be a lie about a file the user can see in the list, and the
   * reason is the only thing that tells them which line of it to fix.
   */
  expand(spaceId: string | null, name: string, args: string, cwd: string | null = null): { command: UserCommand; text: string; missing: string[] } {
    const all = this.list(spaceId, cwd).commands;
    const key = commandKey(name);
    const command = runnableCommands(all).find((c) => commandKey(c.name) === key);
    if (!command) {
      const broken = all.find((c) => commandKey(c.name) === key);
      if (!broken) throw new NotFoundError("command", `/${name}`);
      throw new RpcError("BAD_REQUEST", `/${name} cannot run: ${broken.reason ?? `it is shadowed by ${broken.shadowedBy}`}`);
    }
    let text: string;
    try { text = readFileSync(command.path, "utf8"); }
    catch { throw new RpcError("BAD_REQUEST", `/${name} cannot run: the file could not be read`); }
    return { command, ...expandCommand(splitDocument(text).body, args) };
  }

  /**
   * Every root, with what it actually contributed — the "why is this command here, and what else is
   * Realm looking at" panel, and the same shape (and the same `count: 0` rule) as `skills.sources`.
   */
  sources(spaceId: string | null, cwd: string | null = null): Array<{ kind: CommandOrigin["kind"]; key: string; label: string; path: string; count: number; writable: boolean }> {
    const { commands } = this.list(spaceId, cwd);
    return this.roots(spaceId, cwd).map((r) => ({
      kind: r.kind, key: r.key, label: r.label, path: r.root, writable: r.writable,
      count: commands.filter((c) => c.origin.key === r.key).length,
    }));
  }
}

/** Every `*.md` under `dir`, as `/`-separated paths relative to it, sorted. Sub-folders are walked,
 *  because `commands/git/commit.md` is Claude's `/git:commit`; hidden ones and `node_modules` are not,
 *  since `<space>/commands` is a common name for a source folder and a dependency tree is never a
 *  command source. A folder reached twice through symlinks is read once. An unreadable or absent
 *  directory is an empty one, never an exception. */
function files(dir: string, rel = "", seen = new Set<string>()): string[] {
  let real: string;
  try { real = realpathSync(dir); } catch { return []; }
  if (seen.has(real)) return [];
  seen.add(real);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const path = join(dir, e.name);
    const isFolder = e.isDirectory() || (e.isSymbolicLink() && isDir(path));
    if (isFolder) out.push(...files(path, `${rel}${e.name}/`, seen));
    else if (e.isFile() || e.isSymbolicLink()) out.push(`${rel}${e.name}`);
  }
  return out;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** A file's frontmatter and template. No fence at all means the whole file is the template. */
function splitDocument(text: string): CommandDocument {
  const doc = parseSkillDocument(text);
  return doc ? { frontmatter: doc.frontmatter, body: doc.body } : { frontmatter: null, body: text };
}

/** The first `COMMAND_HEAD_BYTES` of a file, and whether that was all of it. */
function readHead(path: string): { text: string; whole: boolean } {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(COMMAND_HEAD_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return { text: buf.subarray(0, Math.min(n, COMMAND_HEAD_BYTES)).toString("utf8"), whole: n <= COMMAND_HEAD_BYTES };
  } finally { closeSync(fd); }
}

/**
 * One file, for a list: only its head is read, so a list costs the same however large the commands
 * are. The whole file is read only when the head cannot answer — a frontmatter block that does not
 * close inside it, or nothing under the frontmatter yet. Every failure here produces a
 * listed-but-invalid command, never an exception — the property that makes a malformed template
 * findable instead of missing.
 */
function readMeta(path: string, name: string): CommandMeta {
  try {
    const head = readHead(path);
    let doc = splitDocument(head.text);
    const unsure = doc.frontmatter ? !doc.body.trim() : head.text.trimStart().startsWith("---");
    if (!head.whole && unsure) doc = splitDocument(readFileSync(path, "utf8"));
    return readCommandDocument(name, doc);
  } catch {
    return { description: "", argumentHint: null, valid: false, reason: "the file could not be read" };
  }
}
