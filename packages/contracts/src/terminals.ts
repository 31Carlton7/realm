import { isCaretShape, type CaretShape } from "./caret";

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
 * is how you find the cursor in a wall of output. HOW it blinks is the app's caret animation
 * (Appearance ▸ Cursor, `caret.ts`), so a terminal fades where the prompter fades — and where that
 * animation is Solid this switch still means what it says, a plain blink: someone who wants the caret
 * they type with to hold still may well want the one marking a shell's output to blink.
 *
 * The blink is a CSS animation on the cell xterm's DOM renderer marks as the cursor, so Reduce motion
 * and Low power hold it still along with everything else in the window.
 */
export const TERMINALS_CURSOR_BLINK_KEY = "terminals.cursorBlink";
export const TERMINALS_CURSOR_BLINK_DEFAULT = true;

export const TERMINALS_CURSOR_BLINK_COPY = {
  label: "Blink the terminal cursor",
  detail: "With the animation above, or a plain blink where that is Solid.",
} as const;

/**
 * What shape a terminal's cursor is: any caret shape, its own choice rather than the text caret's.
 *
 * A block is the default because it is what a TUI is drawn against — a full-cell cursor is the one
 * that reads correctly on top of a character — while a line is what someone coming from an editor
 * expects, and an underline is the one that never hides the glyph it is standing on.
 *
 * xterm draws three shapes itself, and `TerminalCursorStyle` is its word for them: the hub hands
 * xterm the nearest of the three and the stylesheet draws the rest of the shape on the cell xterm
 * marks. A program may ask for one of the three too (DECSCUSR), and has it until it asks for the
 * default back — which is this setting again, not xterm's blinking block.
 *
 * Its own setting rather than a mode of the blink: a line that does not blink and a blinking block
 * are both things people ask for, and folding them into one control would make half the pairs
 * unreachable.
 */
export const TERMINAL_CURSOR_STYLES = ["block", "bar", "underline"] as const;
export type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number];

export const TERMINALS_CURSOR_STYLE_KEY = "terminals.cursorStyle";
export const TERMINALS_CURSOR_STYLE_DEFAULT: CaretShape = "block";

/** The stored shape. The key held xterm's three words before it held a caret shape, and two of them
 *  are shapes already; the third, `bar`, is xterm's name for a line. Anything else is the default. */
export function terminalCaretShape(raw: unknown): CaretShape {
  if (raw === "bar") return "line";
  return isCaretShape(raw) ? raw : TERMINALS_CURSOR_STYLE_DEFAULT;
}

export const TERMINALS_CURSOR_STYLE_COPY = { label: "Terminal cursor" } as const;

/**
 * Which side of a session pane its terminal (⌘J) opens on.
 *
 * Right, the default, is a tab of the session's side pane — the pane beside it where the browsers,
 * documents and devices its agents open go too — started in the session's checkout. Bottom is the
 * layout people bring from an editor, a shell under the work rather than beside it: a dock along the
 * pane's foot, pinned when the pane can spare the height and floating when it cannot, and closing it
 * keeps the shell.
 */
export const TERMINAL_DOCK_EDGES = ["right", "bottom"] as const;
export type TerminalDockEdge = (typeof TERMINAL_DOCK_EDGES)[number];

export const TERMINALS_DOCK_KEY = "terminals.dock";
export const TERMINALS_DOCK_DEFAULT: TerminalDockEdge = "right";

export const isTerminalDockEdge = (x: unknown): x is TerminalDockEdge =>
  typeof x === "string" && (TERMINAL_DOCK_EDGES as readonly string[]).includes(x);
