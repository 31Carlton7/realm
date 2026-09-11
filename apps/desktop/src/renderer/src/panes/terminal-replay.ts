/**
 * Turning a scrollback read into the exact string to write into xterm.
 *
 * Pure, and separate from the hub, because the escape sequences below are the part that can silently
 * break a pane and the only way to test them without a real terminal is to assert on the string.
 */
import type { MethodResult } from "@realm/contracts";

export type ScrollbackRead = MethodResult<"terminals.read">;

/**
 * Leave the alternate screen, and reset SGR.
 *
 * This is load-bearing and worth the three bytes. A raw tail captured while `vim`, `htop` or `less`
 * held the alternate screen ends mid-alt-buffer, and replaying it puts the restored pane there too —
 * so every byte the NEW shell prints lands in a buffer nobody is looking at, and the pane appears
 * frozen on somebody else's editor. `\x1b[?1049l` comes back; `\x1b[0m` drops whatever colour and
 * inverse state the captured screen was in, so the new shell's first line is not bold red on cyan.
 *
 * This is the one way a raw-tail replay can break a pane, and it closes here.
 */
export const LEAVE_ALT_SCREEN = "\x1b[?1049l\x1b[0m";

/** A dim line the pane owns, to mark where the replay stops and the live shell starts. */
const rule = (label: string): string => `\r\n\x1b[2m── ${label} ──\x1b[0m\r\n`;

export type ReplayOptions = {
  /** Whether a pty is attached. A pane with no pty says so rather than looking idle. */
  running: boolean;
  /** Label the history block. False for a catch-up, where the client already has context on screen
   *  and a rule would be a line drawn through the middle of its own output. */
  labelled?: boolean;
};

/**
 * The string to write, for one read.
 *
 * Three shapes, and the rules between them are the whole of it:
 *
 *   - history and live — a restored terminal: the previous screen, the escape back out of whatever
 *     the previous shell left us in, a rule, then this shell's output.
 *   - live only — an ordinary catch-up: exactly what was missed, and nothing else. No rule, because
 *     a rule here would cut through the middle of the user's own output.
 *   - neither — nothing to say.
 */
export function replayString(read: Pick<ScrollbackRead, "history" | "live">, opts: ReplayOptions): string {
  const parts: string[] = [];
  if (read.history && read.history.data !== "") {
    if (opts.labelled !== false) parts.push(rule("earlier"));
    parts.push(read.history.data);
    // ALWAYS after a history block, whether or not anything follows: the captured tail may have left
    // us in the alternate screen, and everything after this — including the user's own typing — would
    // otherwise go somewhere invisible.
    parts.push(LEAVE_ALT_SCREEN);
    parts.push(opts.running ? rule("now") : rule("not running"));
  }
  if (read.live !== "") parts.push(read.live);
  return parts.join("");
}

/**
 * What the pane's state word says — the `MachineMeta` precedent, a word rather than a dot or a
 * colour, because "this is not live" is a sentence and not a severity.
 *
 * `Replayed` only while the history is all there is on screen: the moment the new shell prints
 * anything, the pane is live and says nothing at all. Where the owner has said nothing, show nothing.
 */
export type TerminalStateWord = "Replayed" | "Not running" | null;

export function terminalStateWord(s: { running: boolean; replayed: boolean; liveSinceReplay: boolean }): TerminalStateWord {
  if (!s.running) return "Not running";
  if (s.replayed && !s.liveSinceReplay) return "Replayed";
  return null;
}
