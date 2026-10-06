/**
 * `owner/repo` from the four address forms GitHub hands out. Null for anything else — GitLab,
 * Bitbucket, a bare path — which is a `compare` we must not fabricate.
 *
 * Its own module, pure and import-free, because two readers need it and only one of them may hold
 * git-write: pushing and opening pull requests is reached from the human's click alone (the RPC layer
 * and app.ts — delegation/structure.test.ts), and Code review, which only reads, must not import it.
 */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}
