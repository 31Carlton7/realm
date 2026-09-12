import { z } from "zod";
import { SESSION_MODES } from "./presets";

/**
 * A user-defined slash command's identity is its **filename**, not anything in its frontmatter.
 *
 * That is the skills rule (`skills.ts`) deliberately repeated: the filename is unique by construction
 * inside a directory and it is the one thing that survives a file Realm cannot parse — and an
 * unparseable command still has to be listable, or the user has no way to find out why `/standup`
 * stopped existing.
 *
 * The charset is narrower than `SkillIdSchema`'s and the narrowing is load-bearing, not tidiness. The
 * prompter scans a `/`-token with `[a-z0-9-]` (`slash-commands.ts`'s `slashQueryAt`) and filters it
 * with a lower-cased prefix match (`filterSlashCommands`), so a name outside this set is a command
 * that can be listed and never typed, and an upper-case one never matches what the user typed.
 *
 * It is also why discovered commands are NOT namespaced the way non-library skills are: `.` is not in
 * the token charset, so an `agents.foo`-shaped name would be untypeable. Collisions are settled by
 * source precedence instead (see `shadowedBy`), which is the only rule that leaves every name typeable.
 */
export const CommandNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a command name is lower-case letters, digits and hyphens");

/** Commands are Markdown files, and only Markdown files. Anything else in the directory — a README's
 *  images, a `.DS_Store`, an editor's swap file — is not a template someone wrote to be expanded. */
export const COMMAND_FILE_EXT = ".md";

/** The command a file defines, or null when the file is not one. Case-folded, because macOS will hand
 *  back `Standup.md` for a file created as `standup.md` and the two must name one command. */
export function commandNameFromFile(file: string): string | null {
  if (!file.toLowerCase().endsWith(COMMAND_FILE_EXT)) return null;
  const name = file.slice(0, -COMMAND_FILE_EXT.length).toLowerCase();
  return CommandNameSchema.safeParse(name).success ? name : null;
}

/**
 * Where a command was found, in PRECEDENCE order — first one to define a name owns it.
 *
 *  - `space` — the space folder's `commands/`. Closest to the work, so it wins: a repo that ships a
 *    `/review` for its own conventions should beat the user's generic one, the same way a project's
 *    `.claude/skills` is the most specific skills root.
 *  - `user`  — `<REALM_HOME>/commands`, visible in every space.
 *  - `agent` — an agent's own directory (`~/.claude/commands`). Read-only to Realm, always: this is the
 *    same promise the skills scan makes about `~/.claude`, and it is the reason `writable` exists on
 *    the origin rather than being inferred from the kind by each caller that cares.
 */
export const COMMAND_ORIGIN_KINDS = ["space", "user", "agent"] as const;
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

export const UserCommandSchema = z.object({
  /** The word after the slash — the filename, minus `.md`. */
  name: CommandNameSchema,
  /** Frontmatter `description`: what the picker shows beside the name, so it earns its width. */
  description: z.string(),
  /** Frontmatter `argument-hint` (`<file> [--fix]`), or null. Its presence is also what tells the
   *  prompter this command is nothing without an argument — the same job `SlashCommand.takesArgument`
   *  does for a built-in, derived rather than declared so a template and its picker cannot disagree. */
  argumentHint: z.string().nullable(),
  /** The template, verbatim, frontmatter removed. `expandCommand` turns this into the message. */
  body: z.string(),
  /** Absolute path of the `.md` file — what "Open in editor" opens and what `shadowedBy` points at. */
  path: z.string(),
  origin: CommandOriginSchema,
  /** False when the file cannot be run as written: no frontmatter, no description, no template, or a
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
 * remembering to — and hardcoded for the six that are literals in the prompter. `commands.test.ts`
 * greps `SessionPane.tsx` to keep the hardcoded half honest: an app command added without a line
 * here would silently take a name a user's file may already be using.
 *
 * A stale name here costs the user one name they cannot use. A missing one costs them a command that
 * quietly stops running, which is the failure worth over-reserving to avoid.
 */
export const RESERVED_COMMAND_NAMES: readonly string[] = [
  ...SESSION_MODES.map((m) => m.id),
  "attach", "connections", "diff", "export", "goal", "skills",
].sort();

export const isReservedCommandName = (name: string): boolean => RESERVED_COMMAND_NAMES.includes(name);

/**
 * How much of a command file is read.
 *
 * Far tighter than `SKILL_TEXT_MAX`, and for the opposite reason: a `SKILL.md` is a document an agent
 * consults, while this is a message that is about to be SENT — every byte of it is a byte of the
 * turn. 100k is a very long prompt and a very short file, so a `.md` above it is not a template
 * someone wrote; it is something else that landed in the directory. Over the cap the file is listed
 * as invalid and SAID to be too big, never quietly truncated into a prompt that stops mid-sentence.
 */
export const COMMAND_TEXT_MAX = 100_000;

/** A file's frontmatter and the text under it. `frontmatter: null` means there was no `---` block at
 *  all, which is a different failure from an empty one and gets a different sentence. */
export type CommandDocument = { frontmatter: Record<string, string> | null; body: string };

/** The half of a `UserCommand` that comes out of the file itself; everything else is per-scan. */
export type CommandMeta = Pick<UserCommand, "description" | "argumentHint" | "body" | "valid" | "reason">;

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
 * Order of the checks is the order of the fixes. A reserved name is first because the file cannot run
 * under that name however well-formed the rest of it is.
 */
export function readCommandDocument(name: string, doc: CommandDocument): CommandMeta {
  const description = doc.frontmatter?.description?.trim() ?? "";
  const hint = doc.frontmatter?.["argument-hint"]?.trim() ?? "";
  // Kept even when invalid, unlike the skills reader's `invalidMeta`: there is no id to fall back to
  // here, and a viewer that shows what it managed to read is how the author sees what it missed.
  const meta = { description, argumentHint: hint || null, body: doc.body };
  if (isReservedCommandName(name)) return { ...meta, valid: false, reason: `/${name} is one of Realm's own commands — rename this file to use it` };
  if (!doc.frontmatter) return { ...meta, valid: false, reason: "no `---` frontmatter block" };
  // The description is the whole basis on which the picker offers a command, and the picker is the
  // only place most of these are ever found. One without a description is not a command that reads
  // badly, it is a command nobody discovers.
  if (!description) return { ...meta, valid: false, reason: "frontmatter has no `description`" };
  if (!doc.body.trim()) return { ...meta, valid: false, reason: "no template under the frontmatter" };
  return { ...meta, valid: true, reason: null };
}

/** The commands `/name` would actually run — valid, and not shadowed by a closer source. The picker's
 *  list and the server's expansion both go through this, so they cannot offer different sets. */
export const runnableCommands = (commands: readonly UserCommand[]): UserCommand[] =>
  commands.filter((c) => c.valid && c.shadowedBy === null);

/**
 * `$ARGUMENTS`, and `$1`…`$9`.
 *
 * One alternation and one pass, so substituted text is never rescanned: an argument that contains the
 * literal `$1` must land in the message as `$1`, not as the first word again.
 *
 * `(?![0-9])` is what keeps `$10` out of it. Without it `$10` expands to the first word followed by a
 * stray `0` — a template that silently means something else, which is exactly the class of failure
 * this whole function is written to avoid.
 */
const PLACEHOLDER = /\$ARGUMENTS\b|\$([1-9])(?![0-9])/g;

/**
 * Expand a template against what the user typed after the command.
 *
 * **An unmatched `$3` is left standing, and reported.** The alternative — substituting an empty
 * string — is the silent one: "compare $1 and $2" with one word typed still reads as a complete
 * English sentence about one thing, and the agent would answer the wrong question with no sign that
 * anything was missing. A literal `$3` in the draft is unmistakable.
 *
 * That is only true because the expansion lands in the PROMPTER'S DRAFT and not straight on the wire:
 * the user reads the sentence before pressing Return, which is where a literal `$3` is unmissable.
 * Any caller that auto-sends an expansion owes the user the other behaviour — a non-empty `missing`
 * has to be a refusal there, because nobody is going to read it first.
 *
 * `$ARGUMENTS` is different and substitutes even when empty: it means "the rest of the line", the
 * rest of the line genuinely is empty, and there is no other word it could have meant. Over-supply
 * (three words typed at a template that only uses `$1`) is deliberately not reported — a template
 * that names one slot is a template that takes one word, and `argument-hint` is where it says so.
 */
export function expandCommand(template: string, args: string): { text: string; missing: string[] } {
  const rest = args.trim();
  const words = rest ? rest.split(/\s+/) : [];
  const missing: string[] = [];
  const text = template.replace(PLACEHOLDER, (token: string, digit: string | undefined) => {
    if (digit === undefined) return rest;
    const word = words[Number(digit) - 1];
    if (word !== undefined) return word;
    if (!missing.includes(token)) missing.push(token);
    return token;
  });
  return { text, missing };
}
