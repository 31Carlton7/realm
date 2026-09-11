/**
 * What to do about a daemon running code this app cannot drive.
 *
 * `decideLaunch` says a handoff is needed; this says how to take it, and the split matters because
 * the two questions have different inputs. Whether the daemon is ours is a fact about pids and boot
 * ids; whether we may stop it is a fact about what is running inside it and what the user wants.
 *
 * **The gate ships before the drain, and is always correct.** Stopping a daemon and starting the new
 * one loses nothing a restart would not have lost anyway: sessions resume from their provider ids by
 * the ordinary boot path, runs are requeued by `recoverOnBoot`, and terminals come back with their
 * scrollback. The only thing it costs is a turn that happens to be mid-flight — which is exactly why
 * the user is asked when there is one, and not asked when there is not.
 */

/** What `daemon.info` said about the daemon we are about to replace, or null when it could not be
 *  asked — in which case we must assume something is working, because claiming nothing is is the one
 *  wrong answer here. */
export type DaemonWork = { working: number; activeRuns: number } | null;

export type HandoffDecision =
  /** Stop it and start ours. Nothing is working, so nobody needs telling. */
  | { kind: "restart" }
  /** Ask. `working` is what the dialog names; `keepable` is whether *Keep working* is on offer at
   *  all — it is not when the running daemon speaks a protocol this app cannot drive, because
   *  "carry on" would mean carrying on with a socket we cannot use. */
  | { kind: "confirm"; working: number; keepable: boolean }
  /** Adopt the old daemon and say so, until the user restarts. Only reachable from `confirm`. */
  | { kind: "keep" }
  /** Refuse to work against it: the wire is incompatible, so there is nothing to keep. */
  | { kind: "blocked" };

export function decideHandoff(d: { why: "bundle" | "protocol"; work: DaemonWork }): HandoffDecision {
  // A daemon that will not answer `daemon.info` is a daemon we know nothing about. Treat it as busy:
  // a dialog somebody dismisses costs a click, and a silent stop costs a turn.
  const busy = d.work === null || d.work.working > 0 || d.work.activeRuns > 0;
  if (!busy) return { kind: "restart" };
  return { kind: "confirm", working: d.work === null ? 0 : d.work.working + d.work.activeRuns, keepable: d.why === "bundle" };
}

/**
 * The dialog's words.
 *
 * `Restart now` names what actually happens to the work, because "restart" on its own reads as
 * "lose it" — and the thing that makes this safe is precisely that sessions come back. `working` of 0
 * means we could not ask; the copy says so rather than naming a number it does not have.
 */
export function handoffCopy(d: { working: number; keepable: boolean }): { message: string; detail: string; restart: string; keep: string } {
  const what = d.working === 0
    ? "Realm could not check what is running."
    : `${d.working === 1 ? "1 session or task is" : `${d.working} sessions and tasks are`} working.`;
  return {
    message: "Realm was updated. Restart the agent server?",
    detail: d.keepable
      ? `${what} Restarting stops them and starts them again — sessions resume where they left off, and terminals come back with what they printed. Keeping the old server working means running the previous version until you restart.`
      : `${what} The server that is running speaks a version of Realm's protocol this app cannot use, so it has to be restarted before anything will work.`,
    restart: "Restart now",
    keep: "Keep working",
  };
}
