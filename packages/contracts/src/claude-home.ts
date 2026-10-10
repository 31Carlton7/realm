import { z } from "zod";
import { AGENT_CLI_COMMANDS, AGENT_LOGIN_HINTS } from "./presets";

/** The longest folder path a profile may name. */
export const CLAUDE_DIR_MAX = 1024;

/**
 * A profile's Claude config folder, as the server answers it.
 *
 * Claude Code keeps a sign-in, its conversations, its settings and its memory in one folder, and
 * `CLAUDE_CONFIG_DIR` says which. A person with several accounts keeps a folder for each, and a
 * profile can name the one its sessions run under. `dir` null is the default folder: whichever one
 * Realm's own environment resolves, which is what every profile ran under before a profile could
 * name its own.
 */
export const ClaudeDirSchema = z.object({
  /** The folder the profile names, spelled as it is handed to the CLI, or null for the default one. */
  dir: z.string().nullable(),
  /** The folder in force: `dir`, or the default folder where none is named. */
  inForce: z.string(),
  /** A folder is named and is not a directory now. Nothing is started under it, since the CLI makes
   *  a folder it is pointed at and does not find. */
  missing: z.boolean(),
  /** The variable in Realm's environment that Claude Code uses in place of any folder's sign-in (an
   *  API key or a token), or null where there is none. */
  override: z.string().nullable(),
  /** Realm runs Claude under some folder besides the default one: a profile names one, a
   *  conversation is noted under one, or a process is running under one whose conversation is not
   *  noted yet. Said of the whole install and not of this profile. While it is false every session
   *  is on the default folder's sign-in, so nothing has to be asked about a session to know whose
   *  account it runs on. */
  anyNamed: z.boolean(),
});
export type ClaudeDir = z.infer<typeof ClaudeDirSchema>;

/**
 * `path` as a person writes it: `~` for their home folder. A path outside that folder, and any path
 * where the home folder is not known, is shown as it is.
 */
export function tildePath(path: string, home: string | null | undefined): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const quoted = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * The line that signs Claude Code in to `home`, for a terminal to run or a card to offer.
 *
 * The default folder gets the table's own command. A named folder gets that command behind `env`,
 * which is a program and not a shell word: a person's shell may define `claude` as a function that
 * picks a folder by working directory, and a variable set in front of a function is the function's
 * to overwrite. `bin` is the path of the `claude` to run where none is on PATH (the copy Realm
 * carries), quoted as the folder is.
 */
export function claudeLoginLine(home: string | null, bin: string | null = null): string {
  const [word, ...args] = AGENT_CLI_COMMANDS.claude.login.split(/\s+/);
  const command = [bin === null ? word : quoted(bin), ...args].join(" ");
  return home === null ? command : `env CLAUDE_CONFIG_DIR=${quoted(home)} ${command}`;
}

/** The sentence beside that line. For a named folder it says where the sign-in is kept, since the
 *  table's own names a bare command that would sign another folder in. */
export function claudeLoginHint(home: string | null): string {
  return home === null ? AGENT_LOGIN_HINTS.claude : `Uses the \`claude\` login kept in ${home}. Sign in there if sessions fail to authenticate.`;
}
