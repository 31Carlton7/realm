/** Every branch Realm creates is `realm/<slug>`. The prefix makes Realm's branches obvious in
 *  `git branch`, and puts them in a namespace the user's own `main`/`feat/...` can never collide
 *  with. The slug contains no `/`, so `realm/a` and `realm/a/b` can never both exist (git stores
 *  refs as files and would refuse the second). */
export const BRANCH_PREFIX = "realm/";
export const SLUG_MAX = 40;

/**
 * A branch/directory name derived from a session title. Titles are free text: spaces, slashes,
 * emoji, `..`, control characters, a leading dot, a trailing `.lock` — every one of which git
 * refuses in a ref name (git-check-ref-format(1)) or a filesystem dislikes in a path component.
 *
 * The rule is an allowlist, not a blocklist: anything outside `[a-z0-9._-]` becomes `-`. A
 * blocklist of git's forbidden characters would be one release behind git and would still let
 * emoji, RTL overrides and path separators through.
 *
 * Here rather than in the server because the sheet that names a worktree shows the branch it will
 * get as it is typed; the server's name search may still add `-2` when that one is taken.
 */
export function slugifyBranch(title: string): string {
  const slug = title
    .normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    // `..` and `@{` are illegal in refs; runs of separators are merely ugly. Collapse both.
    .replace(/\.+/g, ".").replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, SLUG_MAX)
    // The slice can leave a fresh trailing separator, and `.lock` is illegal at the end of any
    // ref component however it got there.
    .replace(/[-._]+$/, "").replace(/\.lock$/, "").replace(/[-._]+$/, "");
  return slug || "session";
}
