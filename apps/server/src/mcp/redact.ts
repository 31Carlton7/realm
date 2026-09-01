/**
 * The redaction rules `hub.ts` and `oauth.ts` both apply to error messages before they become anything
 * a user, a log row, or an agent can see.
 *
 * Shared rather than duplicated because the two halves of the story are useless apart: `oauth.ts` knows
 * the bare token, `hub.ts` knows the header value that wraps it, and an upstream error can quote either
 * form. When the two files kept their own copies of the rule they drifted — the hub scrubbed only the
 * full `"Bearer <token>"` string, so a 401 body quoting the BARE token (`{"error":"invalid_token",
 * "token":"at_xyz"}`) sailed straight through into `mcp_call_log.result_summary`, the `mcp.call`
 * broadcast, and the agent's own tool-result context.
 */

/**
 * Values shorter than this are never redacted. A two- or three-character credential fragment appears
 * inside ordinary English constantly, and replacing every occurrence would turn an error message into
 * swiss cheese — losing the diagnostic entirely to protect a value that short is a bad trade, and a
 * credential that short is not one.
 */
export const REDACT_MIN_LENGTH = 4;

export const REDACTED = "[redacted]";

/**
 * Expand raw credential values into every form an upstream error might quote them in.
 *
 * For a scheme-prefixed value (`"Bearer at_xyz"`, `"Basic dXNlcjpwdw=="`) that is BOTH the whole header
 * value and the bare credential after the first space — an authorization server rejecting a token
 * quotes it either way, and only one of the two matches any given error body.
 *
 * The split is deliberately naive (first space, whatever follows) rather than a scheme grammar. It can
 * over-expand a value that merely contains a space — a stdio env var like `EXTRA_ARGS="--verbose
 * --debug"` also contributes `"--debug"` — which costs an error message a needless `[redacted]`. That
 * is the safe direction: over-redaction is cosmetic, under-redaction is the leak this module exists to
 * prevent.
 */
export function credentialValues(values: Iterable<string>): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    out.push(value);
    const space = value.indexOf(" ");
    // `> 0`, not `>= 0`: a leading space means there is no scheme in front, so the "credential after the
    // scheme" is just the value with whitespace shaved — nothing the whole value does not already cover.
    if (space > 0) {
      const bare = value.slice(space + 1);
      if (bare) out.push(bare);
    }
  }
  return out;
}

/** Replace every occurrence of every value (at or above the length floor) with `[redacted]`. */
export function redactValues(message: string, values: Iterable<string>): string {
  let out = message;
  for (const value of values) {
    if (value.length >= REDACT_MIN_LENGTH) out = out.split(value).join(REDACTED);
  }
  return out;
}
