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
