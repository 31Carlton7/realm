/**
 * A throw in main that nothing catches is logged, and main carries on.
 *
 * With no `uncaughtException` listener, Electron shows the error in `dialog.showErrorBox`. On macOS
 * that is an app-modal alert run on main's thread: every window, IPC call and timer waits behind it
 * until someone presses OK, and nobody may be at the Mac (#567). Electron carries on after the box,
 * so leaving it out changes nothing else.
 *
 * Both lines say "Uncaught", the word the release check counts in the packaged app's stderr, so a
 * throw still fails a release. Main has no log file of its own: its log is stderr.
 */
export function logUncaught(proc: Pick<NodeJS.EventEmitter, "on"> = process): void {
  proc.on("uncaughtException", (error: unknown) => console.error(`[main] Uncaught ${withStack(error)}`));
  proc.on("unhandledRejection", (reason: unknown) => console.error(`[main] Uncaught (in promise) ${withStack(reason)}`));
}

function withStack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
}
