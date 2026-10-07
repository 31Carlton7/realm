import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import {
  COMMAND_TEXT_MAX, commandNameFromFile, expandCommand, readCommandDocument, runnableCommands,
  type CommandMeta, type CommandOrigin, type UserCommand,
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
  roots(spaceId: string | null): CommandOrigin[] {
    const out: CommandOrigin[] = [];
    const folder = spaceId ? this.d.spaces?.folderPathOf(spaceId) ?? null : null;
    if (folder) out.push({ kind: "space", key: "space", label: `${basename(folder)}/commands`, root: join(folder, "commands"), writable: true });
    out.push({ kind: "user", key: "user", label: tildify(this.root, this.userHome), root: this.root, writable: true });
    // One agent directory, deliberately. `~/.claude/commands` is the one whose file format Realm has
    // actually read — frontmatter `description`/`argument-hint`, `$ARGUMENTS` and `$1`…`$9` in the
    // body — and that dialect is the whole reason a discovered file can be expanded at all. A second
    // agent's folder means reading ITS dialect first: a template whose placeholders mean something
    // else would not fail, it would quietly send a different prompt than the one written.
    const claude = join(this.claudeDir, "commands");
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
  list(spaceId: string | null): { root: string; commands: UserCommand[] } {
    const winners = new Map<string, string>();
    const commands: UserCommand[] = [];
    for (const origin of this.roots(spaceId)) {
      for (const file of files(origin.root)) {
        // A name outside the charset is skipped rather than listed, exactly as `SkillsService.dirNames`
        // skips a directory that is not an addressable id: there is no name under which to report it,
        // and a row nothing can be typed to reach is not a row.
        const name = commandNameFromFile(file);
        if (!name) continue;
        const path = join(origin.root, file);
        const meta = read(path, name);
        const shadowedBy = winners.get(name) ?? null;
        if (meta.valid && !shadowedBy) winners.set(name, path);
        commands.push({ name, ...meta, path, origin, shadowedBy });
      }
    }
    return { root: this.root, commands: commands.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /** The commands `/name` would actually run, for the prompter's picker. */
  runnable(spaceId: string | null): UserCommand[] {
    return runnableCommands(this.list(spaceId).commands);
  }

  /**
   * Expand one command against what the user typed after it.
   *
   * A name that exists but cannot run is refused with the file's OWN reason rather than a bare
   * NOT_FOUND — "no such command" would be a lie about a file the user can see in the list, and the
   * reason is the only thing that tells them which line of it to fix.
   */
  expand(spaceId: string | null, name: string, args: string): { command: UserCommand; text: string; missing: string[] } {
    const all = this.list(spaceId).commands;
    const command = runnableCommands(all).find((c) => c.name === name);
    if (!command) {
      const broken = all.find((c) => c.name === name);
      if (!broken) throw new NotFoundError("command", `/${name}`);
      throw new RpcError("BAD_REQUEST", `/${name} cannot run: ${broken.reason ?? `it is shadowed by ${broken.shadowedBy}`}`);
    }
    return { command, ...expandCommand(command.body, args) };
  }

  /**
   * Every root, with what it actually contributed — the "why is this command here, and what else is
   * Realm looking at" panel, and the same shape (and the same `count: 0` rule) as `skills.sources`.
   */
  sources(spaceId: string | null): Array<{ kind: CommandOrigin["kind"]; key: string; label: string; path: string; count: number; writable: boolean }> {
    const { commands } = this.list(spaceId);
    return this.roots(spaceId).map((r) => ({
      kind: r.kind, key: r.key, label: r.label, path: r.root, writable: r.writable,
      count: commands.filter((c) => c.origin.key === r.key).length,
    }));
  }
}

/** `*.md` files in one directory, sorted. Sub-directories are NOT descended: Claude's nested
 *  `commands/foo/bar.md` is addressed as `/foo:bar` there, and `:` is not in the `/`-token charset
 *  the prompter scans — a nested file would be listed under a name that cannot be typed. An
 *  unreadable or absent directory is an empty one, never an exception. */
function files(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map((e) => e.name).sort();
  } catch { return []; }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** One file. Every failure here produces a listed-but-invalid command, never an exception — the
 *  property that makes a malformed template findable instead of missing. */
function read(path: string, name: string): CommandMeta {
  let size: number;
  try { size = statSync(path).size; }
  catch { return { description: "", argumentHint: null, body: "", valid: false, reason: "the file could not be read" }; }
  // Checked before the read, not after: the point of the cap is not to hold the file in memory.
  if (size > COMMAND_TEXT_MAX) return { description: "", argumentHint: null, body: "", valid: false, reason: `the file is ${size} bytes, too large to be a prompt template` };
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch { return { description: "", argumentHint: null, body: "", valid: false, reason: "the file could not be read" }; }
  // The same document split the skills reader uses, and deliberately not a second one — see
  // `readCommandDocument`'s comment. No fence at all means the whole file is the body, which is how
  // the author gets shown the text they forgot to put a `---` block above.
  const doc = parseSkillDocument(text);
  return readCommandDocument(name, doc ? { frontmatter: doc.frontmatter, body: doc.body } : { frontmatter: null, body: text });
}
