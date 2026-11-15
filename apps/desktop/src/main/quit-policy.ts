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
  | "update-restart"
  /** SIGTERM, SIGINT or SIGHUP: `kill`, a script, ⌃C in the terminal that ran `pnpm dev`. */
  | "signal"
  /** macOS is logging out, restarting or shutting down (`powerMonitor`'s `shutdown`). */
  | "system-shutdown";

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
    case "signal":
      // A signal asks this process to end, not the work: the server is in its own session so that
      // ⌃C and a closed terminal cannot reach it (server-process.ts `spawnDaemon`), and a signal sent
      // with `kill` means the same. The next launch adopts it.
      return { kind: "detach-and-exit" };
    case "system-shutdown":
      // The agents end with the machine either way; stopping them first lets the server close its
      // ptys and database itself. No confirmation: nobody is there to answer it before macOS gives up.
      return { kind: "quit-all" };
  }
}

/** What main's `before-quit` holds about the quit under way. */
export type QuitFlags = {
  /** A gesture that means "stop everything" was taken, so the quit is not turned into resident mode. */
  quittingForReal: boolean;
  /** Exit and leave the daemon as it is. */
  detachOnQuit: boolean;
};

/** The flags a trigger that ends the process sets before it asks for the quit. */
export function quitFlagsFor(trigger: "signal" | "system-shutdown"): QuitFlags {
  return { quittingForReal: true, detachOnQuit: decideQuit({ trigger, working: 0 }).kind === "detach-and-exit" };
}

/**
 * What `before-quit` does with a quit. Every quit arrives there the same way — ⌘Q, the menu, a
 * signal and a logout all become Electron's `app.quit()` — so only the flags tell them apart.
 *   detach        let go of the daemon and exit
 *   go-resident   cancel the quit, close the windows, keep running in the menu bar
 *   stop-server   stop the daemon, then exit
 */
export function beforeQuitStep(flags: QuitFlags): "detach" | "go-resident" | "stop-server" {
  if (flags.detachOnQuit) return "detach";
  if (decideQuit({ trigger: "quit", working: 0 }).kind === "go-resident" && !flags.quittingForReal) return "go-resident";
  return "stop-server";
}

/**
 * Take over the signals Electron answers with a bare `app.quit()` (electron_browser_main_parts_posix.cc).
 * Each is handled once, as Electron's own handler is: with the listener gone Node restores the
 * default action, so a second signal still ends a quit that hangs. Call it after `ready` — Electron
 * installs its handlers just before, and the last one installed is the one a signal reaches.
 */
export function quitOnSignals(proc: Pick<NodeJS.Process, "once">, quit: (signal: NodeJS.Signals) => void): void {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) proc.once(signal, () => quit(signal));
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
