/**
 * Whether the code editor's caret blinks.
 *
 * Separate from `terminals.cursorBlink`, and separate on purpose — the same split VS Code makes
 * between `editor.cursorBlinking` and `terminal.integrated.cursorBlinking`. The two carets are in
 * different places doing different jobs: a terminal's marks where output will land in a screen that
 * is mostly not yours, and an editor's marks where you are typing in a screen that is. Someone who
 * wants one still can be reasonably want the other.
 *
 * On by default, because a caret that never moves is one people lose in a wall of code.
 *
 * Scope is the CODE editor, which draws its own caret and can therefore be told. The prompter's is
 * the platform's: Chromium exposes no way to hold it still until `caret-animation` lands (139; this
 * app ships on 138), so it is out of this switch for exactly as long as that is true, and the switch
 * is named for the surface it can actually reach rather than for every caret in the window.
 */
export const EDITOR_CURSOR_BLINK_KEY = "editor.cursorBlink";
export const EDITOR_CURSOR_BLINK_DEFAULT = true;

/** CodeMirror's own default, in ms. `0` is what turns the animation off rather than slowing it. */
export const EDITOR_CURSOR_BLINK_RATE = 1200;

export const EDITOR_CURSOR_BLINK_COPY = {
  label: "Blink the editor caret",
  detail: "The caret in a code file pulses so it is findable. Turn it off for one that sits still. The prompter's caret is the system's and cannot be told either way yet.",
} as const;
