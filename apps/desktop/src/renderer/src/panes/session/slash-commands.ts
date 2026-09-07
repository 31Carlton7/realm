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
  run: () => void;
};

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
