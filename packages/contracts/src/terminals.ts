/**
 * Terminal scrollback: whether Realm keeps what your shells printed, across a restart.
 *
 * **Off by default, and the copy has to earn that.** Terminal output is whatever your shell printed —
 * a token a CLI echoed, a `.env` you catted, a connection string in a stack trace. Keeping that on
 * disk is a decision a person should make on purpose, so Realm does not make it for them.
 *
 * What the switch does NOT gate is the in-memory buffer, which is always on. That buffer holds bytes
 * that were broadcast to every connected client anyway, and it is what makes reattaching after a
 * dropped socket show the output that arrived meanwhile. Gating it would break catch-up to protect
 * nothing new.
 */
export const TERMINALS_HISTORY_KEY = "terminals.history";
export const TERMINALS_HISTORY_DEFAULT = false;

/** What Settings says, in the words design.md asks for: name the thing, not the feeling. */
export const TERMINALS_HISTORY_COPY = {
  label: "Keep terminal scrollback",
  detail: "Realm stores what your terminals printed so a pane comes back with its output after a restart. Terminal output is whatever your shell printed — including anything a command echoed. Turning this off deletes what has been kept.",
} as const;

/**
 * Whether a terminal's cursor blinks.
 *
 * On by default, because a blinking block is what every terminal emulator on this Mac draws and it
 * is how you find the caret in a wall of output. It is also the one piece of the app that animates
 * forever, which is exactly why it needs a switch: a blink in the corner of the eye is the kind of
 * motion that stops being information and starts being a distraction, and design.md's reduced-motion
 * rule cannot help here — this is xterm's own timer, not a CSS animation.
 *
 * Scope is honest and narrow: the TERMINAL's cursor. The prompter's caret is the platform's, and
 * Chromium exposes no way to stop it blinking until `caret-animation` lands (139; this app ships on
 * 138), so a switch claiming to cover it would be a switch that lies about half of what it names.
 */
export const TERMINALS_CURSOR_BLINK_KEY = "terminals.cursorBlink";
export const TERMINALS_CURSOR_BLINK_DEFAULT = true;

export const TERMINALS_CURSOR_BLINK_COPY = {
  label: "Blink the terminal cursor",
  detail: "The block cursor in a terminal pane pulses so it is findable in a screen of output. Turn it off for a cursor that sits still.",
} as const;

/**
 * What shape a terminal's cursor is.
 *
 * The three every terminal emulator offers, and the three xterm draws. A block is the default
 * because it is what a TUI is drawn against — a full-cell cursor is the one that reads correctly on
 * top of a character — while a bar is what someone coming from an editor expects, and an underline
 * is the one that never hides the glyph it is standing on.
 *
 * Its own setting rather than a mode of the blink: a bar that does not blink and a blinking block
 * are both things people ask for, and folding them into one control would make half the pairs
 * unreachable.
 */
export const TERMINAL_CURSOR_STYLES = ["block", "bar", "underline"] as const;
export type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number];

export const TERMINALS_CURSOR_STYLE_KEY = "terminals.cursorStyle";
export const TERMINALS_CURSOR_STYLE_DEFAULT: TerminalCursorStyle = "block";

export const isTerminalCursorStyle = (x: unknown): x is TerminalCursorStyle =>
  typeof x === "string" && (TERMINAL_CURSOR_STYLES as readonly string[]).includes(x);

export const TERMINALS_CURSOR_STYLE_COPY = {
  label: "Terminal cursor",
  options: { block: "Block", bar: "Bar", underline: "Underline" },
} as const;

/**
 * Which edge of a session pane its terminal (⌘J) opens on.
 *
 * Right is the strip the summary and the sub-agent view share, and stays the default: it is where the
 * terminal has always been. Bottom is the layout people bring from an editor — a shell under the work
 * rather than beside it — and suits a tall pane, where a 560px column is width the transcript needed.
 * Either way it is the same dock by the same rules: pinned when the pane can spare the room, floating
 * when it cannot, and closing it keeps the shell.
 */
export const TERMINAL_DOCK_EDGES = ["right", "bottom"] as const;
export type TerminalDockEdge = (typeof TERMINAL_DOCK_EDGES)[number];

export const TERMINALS_DOCK_KEY = "terminals.dock";
export const TERMINALS_DOCK_DEFAULT: TerminalDockEdge = "right";

export const isTerminalDockEdge = (x: unknown): x is TerminalDockEdge =>
  typeof x === "string" && (TERMINAL_DOCK_EDGES as readonly string[]).includes(x);
