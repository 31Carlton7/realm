/**
 * Whether the code editor's caret blinked — the editor's own switch, before the code editor drew the
 * app's caret (`caret.ts`) and its blink became the caret's animation.
 *
 * Read once, never written: a home that has no caret preference yet but turned this off asked for a
 * caret that holds still, and `parseCaretPrefs` starts its animation at Solid for it.
 */
export const EDITOR_CURSOR_BLINK_KEY = "editor.cursorBlink";

/** CodeMirror's own default, in ms. `0` is what turns the animation off rather than slowing it. It
 *  still paces the editor's SECONDARY cursors, which CodeMirror draws itself. */
export const EDITOR_CURSOR_BLINK_RATE = 1200;
