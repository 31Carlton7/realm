/**
 * What ⌘Q means once the work outlives the window.
 *
 * Before the daemon, closing Realm and stopping the agents were the same act, so there was nothing to
 * decide. Now they are two acts, and the question is which one a given gesture means.
 *
 * The answer Realm takes: closing the window and ⌘Q both mean "put the UI away". They are the
 * gestures a person makes when they are done looking, not when they are done working — a turn that
 * has been running for eight minutes should not end because its window was in the way. Stopping the
 * agents is a separate item with its own words, in the one place that is still visible after the
 * window is gone.
 *
 * The tray must appear the instant the window closes and never lazily, because the failure this
 * design can produce is a person who thinks they quit and did not.
 */
export type QuitTrigger =
  /** The last window closed — a red button, or ⌘W on the only window. */
  | "window-closed"
  /** ⌘Q, or Quit from the application menu. */
  | "quit"
  /** The tray's own *Quit Realm & stop agents*. The only gesture that means both. */
  | "quit-all"
  /** electron-updater is restarting us to install. The daemon is deliberately left alone. */
  | "update-restart";

export type QuitDecision =
  /** Hide the dock icon, put up the tray, leave the daemon running. */
  | { kind: "go-resident" }
  /** Ask first, naming the number. Only ever for the gesture that already means "stop the agents". */
  | { kind: "confirm"; working: number }
  /** Stop the daemon and exit. */
  | { kind: "quit-all" }
  /** Let go of the daemon and exit without stopping it. */
  | { kind: "detach-and-exit" };

export function decideQuit(d: { trigger: QuitTrigger; working: number }): QuitDecision {
  switch (d.trigger) {
    case "window-closed":
    case "quit":
      return { kind: "go-resident" };
    case "quit-all":
      // Confirm only when there is something to lose. A dialog over "Nothing running" is a dialog
      // that teaches people to dismiss dialogs.
      return d.working > 0 ? { kind: "confirm", working: d.working } : { kind: "quit-all" };
    case "update-restart":
      // The opposite of what this hook used to do. Squirrel swaps the bundle and relaunches us; the
      // daemon it finds afterwards is handled by the launcher's handoff, and killing it here would
      // stop every agent for an update the user may not even have noticed.
      return { kind: "detach-and-exit" };
  }
}

/** The confirmation's words. Names the consequence before asking, and counts what is actually at
 *  stake rather than saying "some". */
export function confirmQuitCopy(working: number): { message: string; detail: string; confirm: string } {
  const n = working === 1 ? "1 session is" : `${working} sessions are`;
  return {
    message: `Quit Realm and stop ${working === 1 ? "it" : "them"}?`,
    detail: `${n} working. Quitting stops ${working === 1 ? "that session" : "those sessions"} and every terminal Realm is running. Closing the window instead leaves them running.`,
    confirm: "Quit & stop",
  };
}
