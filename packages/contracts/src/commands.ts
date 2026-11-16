import { z } from "zod";
import { SESSION_MODES } from "./presets";

/**
 * A user-defined slash command's identity is its **path under its root**, not anything in its
 * frontmatter: `review.md` is `/review` and `git/commit.md` is `/git:commit`, which is how Claude
 * names a nested command, so a repo's `.claude/commands` reads the same in both.
 *
 * The filename is unique by construction inside a directory and it is the one thing that survives a
 * file Realm cannot parse — and an unparseable command still has to be listable, or the user has no
 * way to find out why `/standup` stopped existing. So a name is never refused at the door: one that
 * cannot be typed (a space in it) is listed, invalid, with `untypeableReason` as its reason.
 *
 * Case is kept for display and ignored for matching (`commandKey`): Claude lists `Plain_Name.md` as
 * `/Plain_Name`, and typing `/plain_name` should still find it.
 */
export const COMMAND_NAME_CHAR = /[A-Za-z0-9_.:-]/;
export const CommandNameSchema = z.string().regex(/^[A-Za-z0-9_.:-]+$/, "a command name is letters, digits, `-`, `_`, `.` and `:`");

/** What two names are compared by. Every lookup goes through this so `/Review` and `/review` cannot
 *  name two commands in one place and one in another. */
export const commandKey = (name: string): string => name.toLowerCase();

/** Commands are Markdown files, and only Markdown files. Anything else in the directory — a README's
 *  images, a `.DS_Store`, an editor's swap file — is not a template someone wrote to be expanded. */
export const COMMAND_FILE_EXT = ".md";

/** The command a file defines, from its `/`-separated path under the root, or null when it is not
 *  one. Hidden files are not commands; neither is a file inside a hidden folder, which the walk
 *  never enters. */
export function commandNameFromFile(relPath: string): string | null {
  if (!relPath.toLowerCase().endsWith(COMMAND_FILE_EXT)) return null;
  const parts = relPath.slice(0, -COMMAND_FILE_EXT.length).split("/");
  if (parts.some((p) => p === "" || p.startsWith("."))) return null;
  return parts.join(":");
}

/** Why `/name` can never be typed, or null when it can. */
export function untypeableReason(name: string): string | null {
  if (CommandNameSchema.safeParse(name).success) return null;
  return /\s/.test(name)
    ? "the name has a space in it, so it can't be typed after `/` — rename the file"
    : "the name can only be typed with letters, digits, `-`, `_` and `.` — rename the file";
}

/**
 * Where a command was found, in PRECEDENCE order — first one to define a name owns it.
 *
 *  - `space`   — the space folder's `commands/`. Closest to the work, so it wins: a repo that ships a
 *    `/review` for its own conventions should beat the user's generic one, the same way a project's
 *    `.claude/skills` is the most specific skills root.
 *  - `project` — the session's working folder's `.claude/commands`: the commands a repo ships for
 *    Claude, and so the ones a worktree of it brings along. Read-only to Realm, like `agent`.
 *  - `user`    — `<REALM_HOME>/commands`, visible in every space.
 *  - `agent`   — an agent's own directory (`~/.claude/commands`). Read-only to Realm, always: this is
 *    the same promise the skills scan makes about `~/.claude`, and it is the reason `writable` exists
 *    on the origin rather than being inferred from the kind by each caller that cares.
 */
export const COMMAND_ORIGIN_KINDS = ["space", "project", "user", "agent"] as const;
export const CommandOriginKindSchema = z.enum(COMMAND_ORIGIN_KINDS);
export type CommandOriginKind = z.infer<typeof CommandOriginKindSchema>;

export const CommandOriginSchema = z.object({
  kind: CommandOriginKindSchema,
  /** Stable key for this root, unique within a scan. Groups a list and keys a test; unlike the skills
   *  scan's key it is never part of an id, because a command name has to stay typeable. */
  key: z.string(),
  /** One short human label for a group header: "this space", "~/Realm/commands", "~/.claude/commands". */
  label: z.string(),
  /** Absolute path of the directory that was scanned. */
  root: z.string(),
  /** Whether Realm may write here. False for every agent directory, and the honest answer to "can I
   *  edit this in Realm" — a pencil on a file Realm refuses to save is worse than no pencil. */
  writable: z.boolean(),
});
export type CommandOrigin = z.infer<typeof CommandOriginSchema>;

/**
 * One command file, as a list carries it.
 *
 * There is no template here. A list is read every time a session opens, and a command may be any
 * size, so the list reads only each file's head (`COMMAND_HEAD_BYTES`) — enough for the frontmatter
 * and the first line — and `commands.expand` reads the whole file when one is run.
 */
export const UserCommandSchema = z.object({
  /** The word after the slash: the path under its root minus `.md`, folders joined with `:`. Not
   *  `CommandNameSchema`, because a file whose name cannot be typed is still listed, with its reason. */
  name: z.string().min(1),
  /** Frontmatter `description`, or else the template's first line: what the picker shows beside the
   *  name, the same fallback Claude uses for a file with no frontmatter. */
  description: z.string(),
  /** Frontmatter `argument-hint` (`<file> [--fix]`), or null. Its presence is also what tells the
   *  prompter this command is nothing without an argument — the same job `SlashCommand.takesArgument`
   *  does for a built-in, derived rather than declared so a template and its picker cannot disagree. */
  argumentHint: z.string().nullable(),
  /** Absolute path of the `.md` file — what "Open in editor" opens and what `shadowedBy` points at. */
  path: z.string(),
  origin: CommandOriginSchema,
  /** False when the file cannot be run as written: no template, a name that cannot be typed, or a
   *  name a built-in already owns. Listed anyway, exactly as an invalid skill is. */
  valid: z.boolean(),
  /** Why it cannot run, in one sentence. Null when valid. */
  reason: z.string().nullable(),
  /** The path of the file that wins this name, when a higher-precedence source also defines it.
   *  Null for the winner and for every uncontested name.
   *
   *  Kept in the list rather than filtered out of it, because "my command stopped working" and "my
   *  command is being overridden by the one in this repo" are the same symptom, and only one of them
   *  is answerable by a list that shows both files. */
  shadowedBy: z.string().nullable(),
});
export type UserCommand = z.infer<typeof UserCommandSchema>;

/**
 * The names the app's own `/` commands already own.
 *
 * Derived from `SESSION_MODES` where it can be — the mode commands ARE that list (`SessionPane`
 * builds them with `offeredModes`), so a fourth mode reserves its own name without anyone
 * remembering to — and hardcoded for the seven that are literals in the prompter. `commands.test.ts`
 * greps `SessionPane.tsx` to keep the hardcoded half honest: an app command added without a line
 * here would silently take a name a user's file may already be using.
 *
 * A stale name here costs the user one name they cannot use. A missing one costs them a command that
 * quietly stops running, which is the failure worth over-reserving to avoid.
 */
export const RESERVED_COMMAND_NAMES: readonly string[] = [
  ...SESSION_MODES.map((m) => m.id),
  "attach", "connections", "diff", "export", "goal", "share", "skills",
].sort();

/** Case-insensitive, because matching is: `Plan.md` would otherwise be a `/plan` the prompter offers
 *  beside Realm's own. */
export const isReservedCommandName = (name: string): boolean => RESERVED_COMMAND_NAMES.includes(commandKey(name));

/**
 * How much of each file a LIST reads: the frontmatter and the first line of the template, which is
 * all a picker shows. Running a command reads the whole file, whatever its size.
 */
export const COMMAND_HEAD_BYTES = 16 * 1024;

/** A file's frontmatter and the text under it. `frontmatter: null` means there was no `---` block. */
export type CommandDocument = { frontmatter: Record<string, string> | null; body: string };

/** The half of a `UserCommand` that comes out of the file itself; everything else is per-scan. */
export type CommandMeta = Pick<UserCommand, "description" | "argumentHint" | "valid" | "reason">;

/** The template's first non-empty line, as a description. A Markdown heading's `#`s are dropped:
 *  they are how the line is drawn in an editor, not what it says. */
const firstLineOf = (body: string): string =>
  body.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "")?.replace(/^#+\s+/, "") ?? "";

/**
 * Read one command file's frontmatter into the fields a `UserCommand` carries, and decide whether it
 * can run.
 *
 * This interprets a frontmatter block; it does not find one. Splitting the file is
 * `apps/server/src/skills/frontmatter.ts`'s `parseSkillDocument`, which already handles fences, block
 * scalars and quoting, and which the commands service calls before this. Writing a second fence
 * scanner here so that the whole parse could live in `@realm/contracts` was the obvious alternative
 * and the wrong one: two readers of one `---` block eventually disagree about a folded description,
 * and the disagreement would show up as a skill and a command reading the same file differently.
 *
 * Frontmatter is optional, as it is for Claude: a plain `.md` is a template, and its first line is
 * its description. Order of the checks is the order of the fixes. A reserved name is first because
 * the file cannot run under that name however well-formed the rest of it is.
 */
export function readCommandDocument(name: string, doc: CommandDocument): CommandMeta {
  const description = doc.frontmatter?.description?.trim() || firstLineOf(doc.body);
  const hint = doc.frontmatter?.["argument-hint"]?.trim() ?? "";
  const meta = { description, argumentHint: hint || null };
  if (isReservedCommandName(name)) return { ...meta, valid: false, reason: `/${name} is one of Realm's own commands — rename this file to use it` };
  const untypeable = untypeableReason(name);
  if (untypeable) return { ...meta, valid: false, reason: untypeable };
  if (!doc.body.trim()) return { ...meta, valid: false, reason: doc.frontmatter ? "no template under the frontmatter" : "the file is empty" };
  return { ...meta, valid: true, reason: null };
}

/** The commands `/name` would actually run — valid, and not shadowed by a closer source. The picker's
 *  list and the server's expansion both go through this, so they cannot offer different sets. */
export const runnableCommands = (commands: readonly UserCommand[]): UserCommand[] =>
  commands.filter((c) => c.valid && c.shadowedBy === null);

/**
 * Claude's placeholders, read off its CLI (2.1.322): `$ARGUMENTS`, `$ARGUMENTS[N]` and `$N`, where
 * N is ZERO-based and has no upper bound — `$0` is the first word and `$10` the eleventh. A `\$`
 * before one of them is a literal dollar sign.
 *
 * One alternation and one pass, so substituted text is never rescanned: an argument that contains the
 * literal `$1` must land in the message as `$1`, not as a word again. `(?!\w)` keeps `$1st` whole.
 */
const PLACEHOLDER = /(?<!\\)\\\$(?=ARGUMENTS|\d)|\$ARGUMENTS\[(\d+)\]|\$(\d+)(?!\w)|\$ARGUMENTS/g;

/** The words of what was typed, with a quoted run kept as one word, as Claude splits them:
 *  `/compare "old name" new` has two. */
function argumentWords(rest: string): string[] {
  return [...rest.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

/**
 * Expand a template against what the user typed after the command.
 *
 * **An unmatched `$3` is left standing, and reported.** The alternative — substituting an empty
 * string — is the silent one: "compare $0 and $1" with one word typed still reads as a complete
 * English sentence about one thing, and the agent would answer the wrong question with no sign that
 * anything was missing. A literal `$1` in the draft is unmistakable. Claude does the same.
 *
 * That is only true because the expansion lands in the PROMPTER'S DRAFT and not straight on the wire:
 * the user reads the sentence before pressing Return, which is where a literal `$3` is unmissable.
 * Any caller that auto-sends an expansion owes the user the other behaviour — a non-empty `missing`
 * has to be a refusal there, because nobody is going to read it first.
 *
 * `$ARGUMENTS` substitutes even when empty: it means "the rest of the line". A template that names
 * no placeholder at all still gets what was typed, on an `ARGUMENTS:` line under it — Claude's rule,
 * and the one that keeps a plain `.md` from silently dropping the words typed after it.
 */
export function expandCommand(template: string, args: string): { text: string; missing: string[] } {
  const rest = args.trim();
  const words = argumentWords(rest);
  const missing: string[] = [];
  let used = false;
  const text = template.replace(PLACEHOLDER, (token: string, indexed: string | undefined, positional: string | undefined) => {
    if (token.startsWith("\\")) return "$";
    const n = indexed ?? positional;
    if (n === undefined) { used = true; return rest; }
    const word = words[Number(n)];
    if (word !== undefined) { used = true; return word; }
    if (!missing.includes(token)) missing.push(token);
    return token;
  });
  return { text: !used && rest ? `${text}\n\nARGUMENTS: ${rest}` : text, missing };
}
