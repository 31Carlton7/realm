import type { IconName } from "@realm/ui";

/**
 * A command the prompter can run instead of sending a message.
 *
 * These are not agent commands and must never be mistaken for them: nothing here is transmitted, and
 * running one leaves the draft alone unless the command itself clears it. The `@`-mention beside it
 * goes the other way — a mention becomes part of what the agent is told — which is why the two
 * pickers look alike and are worded differently.
 */
export type SlashCommand = {
  /** The word after the slash. Lowercase, no spaces: it is typed, so it has to be typeable. */
  id: string;
  label: string;
  /** What running it does, in the imperative. Shown beside the name, so it earns its width. */
  hint: string;
  icon: IconName;
  /**
   * Run it, with whatever the user had typed after the command.
   *
   * `/goal ship the release notes` is the reason this takes an argument at all: a command that only
   * knew its own name would make the objective a second step. Most commands ignore it and the
   * prompter keeps it in the draft either way — `/plan look at the auth code` flips the mode and
   * leaves the sentence ready to send.
   */
  run: (rest: string) => void;
  /**
   * This command is nothing without an argument — `/goal <objective>`.
   *
   * It changes both ends of the gesture. Picking it from the list ARMS the box (`/goal ` with the
   * caret after it) instead of running on nothing, and Enter on a draft that starts with it runs the
   * command on the rest of the line instead of sending the line to the agent.
   *
   * The second half is the part that could not be done any other way: the picker closes as soon as
   * the caret leaves the token (`slashQueryAt`, deliberately), so by the time an objective has been
   * typed there is no list left to pick from. Enter is the only gesture still available, and for an
   * argument-taking command it has to mean "run it".
   */
  takesArgument?: boolean;
};

/** The command a draft is a call to, and its argument — for Enter, which has no picker to consult.
 *  Null unless the draft opens with the name of an argument-taking command. */
export function slashCallIn(text: string, commands: readonly SlashCommand[]): { command: SlashCommand; rest: string } | null {
  const token = slashQueryAt(text, 1);
  if (!token) return null;
  const id = text.slice(1, token.end);
  const command = commands.find((c) => c.takesArgument && c.id === id);
  if (!command) return null;
  return { command, rest: text.slice(token.end).replace(/^\s+/, "") };
}

/**
 * The `/`-token governing the caret, if any.
 *
 * A command may only open the draft. That is the whole gate, and it is deliberately stricter than
 * the mention scan's "start of a word": a slash is a path separator, a division sign and half of
 * every URL, and a picker that opened inside `src/renderer` or `and/or` would fire constantly while
 * someone was writing an ordinary sentence. At position 0 there is nothing it could be but a
 * command — the message that genuinely starts with a path is the case worth losing.
 *
 * `end` is one past the token's last character, which may extend beyond the caret: picking replaces
 * the whole token, so a completion in the middle of `/exp|ort` leaves no stray `ort` behind.
 */
export function slashQueryAt(text: string, caret: number): { start: number; end: number; query: string } | null {
  if (text[0] !== "/") return null;
  let end = 1;
  while (end < text.length && /[a-z0-9-]/i.test(text[end]!)) end++;
  // The caret has to be inside the token. Once the user has typed past it — "/export the thing" —
  // they are writing a message that happens to start with a slash, and the picker steps aside.
  if (caret < 1 || caret > end) return null;
  return { start: 0, end, query: text.slice(1, caret) };
}

/** Prefix filter over id and label. Prefix rather than substring, unlike the mention picker's: a
 *  command is being TYPED, character by character from its start, and a substring match would keep
 *  offering `/connections` to someone three letters into `/export`. */
export function filterSlashCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  return commands.filter((c) => c.id.startsWith(q) || c.label.toLowerCase().startsWith(q));
}
