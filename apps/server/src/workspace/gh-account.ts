/**
 * Running `gh` as another of the accounts it is signed in to, without changing the one it has active.
 *
 * Its own module, pure and import-free, for the reason `github-remote.ts` is: two things reach GitHub
 * through `gh` — Code review, which only reads and posts reviews, and the pull request Ship opens —
 * and Code review must not import git-write to share it (delegation/structure.test.ts).
 */

/** The one host Realm reads and opens pull requests on: its links, its addresses and its searches
 *  are all github.com's. */
export const GITHUB_HOST = "github.com";

/**
 * What `/bin/sh` runs for a call sent as another of the accounts gh is signed in to: ask gh for that
 * account's token, and start gh with it in `GH_TOKEN`, which gh puts ahead of what it has stored.
 *
 * gh keeps one active account per host and has no flag for "as this one, just now". A shell does it,
 * rather than this process, so that the token goes from one gh to the next and never passes through
 * Realm: nothing here reads it, holds it or could log it, and gh's own active account — the one a
 * terminal uses — is not touched. It is asked for on every call, so a token refreshed in a terminal
 * is the one the next call carries.
 *
 * The command, the login and the host are positional parameters and never text in the script, so
 * nothing in them is read as shell. The token read is kept off stdin, which a review's body arrives
 * on and `exec` hands to the call. No gh at all exits 127, as a spawn of it would report; an account
 * gh no longer has exits 4, gh's own code for "authentication required" — the two states both
 * callers already have words for.
 */
const AS_ACCOUNT = [
  'command -v "$1" >/dev/null 2>&1 || exit 127',
  'GH_TOKEN=$("$1" auth token --user "$2" --hostname "$3" </dev/null 2>/dev/null) && [ -n "$GH_TOKEN" ] || { echo "gh is not signed in to GitHub as $2" >&2; exit 4; }',
  "export GH_TOKEN",
  "gh=$1; shift 3",
  'exec "$gh" "$@"',
].join("\n");

/** The program and arguments that run `command args…` as `login` (`AS_ACCOUNT`). */
export function ghAs(command: string, login: string, args: readonly string[]): [file: string, argv: string[]] {
  return ["/bin/sh", ["-c", AS_ACCOUNT, "realm-gh", command, login, GITHUB_HOST, ...args]];
}
