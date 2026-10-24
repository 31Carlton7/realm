/** A failure the CLI reports as one line and an exit code, never as a stack trace. `code` is the
 *  server's own error code when the server refused, so a script can branch on it. */
export class CtlError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
