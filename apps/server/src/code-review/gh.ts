import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import {
  PR_FILES_MAX, type CheckState, type GhStatus, type PrDetail, type PrFile, type PrFileStatus, type PrPage, type PrRef, type PrState,
  type PrSummary, type ReviewerState, type SubmitReview, type SubmittedReview,
} from "@realm/contracts";
import { RpcError } from "../store/rows";

export type GhResult = { code: number; stdout: string; stderr: string };
/** Running `gh` — injectable, so a suite points at a script of its own: nothing in this repository's
 *  test suite may reach GitHub. `input` is written to its stdin (a review's JSON body). */
export type GhRun = (args: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<GhResult>;

/** A read is a page of a list or one request; a minute is a long time for either to say nothing. */
const GH_TIMEOUT_MS = 60_000;
/** A page of a big change's patches runs to megabytes; a list or a request is a few kilobytes. */
const GH_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The real `gh`, at `command`.
 *
 * It runs with prompts off (`GH_PROMPT_DISABLED`) so a question gh would have asked a terminal is an
 * error here rather than a process waiting forever on a stdin nobody is at, no colour or update
 * notice in what is parsed, and from the temp dir: every call names its repository, so nothing may be
 * inferred from whichever checkout the server happened to start in. ENOENT resolves as exit 127 —
 * "gh is not installed" is a state the page shows, not a crash.
 */
export function ghRunner(command: string): GhRun {
  return (args, opts = {}) => new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      cwd: tmpdir(), timeout: opts.timeoutMs ?? GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER, encoding: "utf8",
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1", CLICOLOR: "0" },
    }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
      if (e?.code === "ENOENT") { resolve({ code: 127, stdout: "", stderr: `${command} is not installed` }); return; }
      if (e?.killed) { reject(new RpcError("GH_TIMEOUT", "GitHub took too long to answer")); return; }
      resolve({ code: typeof e?.code === "number" ? e.code : e ? 1 : 0, stdout, stderr });
    });
    // Closed either way: a gh that reads stdin for a body it was not given would otherwise wait on it.
    child.stdin?.end(opts.input ?? "");
  });
}

const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";

/** gh's own exit code for "authentication required", and the words it and GitHub use for a token
 *  that is missing, expired or revoked. */
const signedOut = (r: GhResult): boolean =>
  r.code === 4 || /gh auth login|authentication required|bad credentials|HTTP 401/i.test(`${r.stderr}\n${r.stdout}`);

/** The words GitHub put in an error body, when it sent one (`gh api` prints it on stdout): a 422 on a
 *  review names the comment it refused, which "Unprocessable Entity" does not. */
function githubMessage(r: GhResult): string | null {
  try {
    const body = JSON.parse(r.stdout) as { message?: unknown; errors?: unknown };
    const details = Array.isArray(body.errors)
      ? body.errors.map((e) => (typeof e === "string" ? e : typeof (e as { message?: unknown })?.message === "string" ? (e as { message: string }).message : null)).filter(Boolean)
      : [];
    const head = typeof body.message === "string" ? body.message : null;
    return [head, ...details].filter(Boolean).join(" — ") || null;
  } catch { return null; }
}

/** A failed call as the error the page shows: one of the states it has words for, or gh's own line. */
function failure(r: GhResult): RpcError {
  if (r.code === 127) return new RpcError("GH_MISSING", "gh is not installed on this Mac");
  if (signedOut(r)) return new RpcError("GH_SIGNED_OUT", "gh is not signed in to GitHub");
  if (/could not resolve to a (?:pullrequest|repository)|HTTP 404/i.test(`${r.stderr}\n${r.stdout}`)) {
    return new RpcError("PR_NOT_FOUND", "GitHub has no pull request there, or this account cannot see it");
  }
  return new RpcError("GH_FAILED", githubMessage(r) ?? (firstLine(r.stderr) || `gh exited with ${r.code}`));
}

function json<T>(r: GhResult): T {
  if (r.code !== 0) throw failure(r);
  try { return JSON.parse(r.stdout) as T; }
  catch { throw new RpcError("GH_FAILED", "gh answered with something that is not JSON"); }
}

const time = (iso: unknown): number => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const login = (actor: unknown): string | null => {
  const l = (actor as { login?: unknown } | null | undefined)?.login;
  return typeof l === "string" && l !== "" ? l : null;
};
const lower = (v: unknown): string => str(v).toLowerCase();

const PR_STATE: Record<string, PrState> = { open: "open", closed: "closed", merged: "merged" };

/** The fields every list row reads, in one fragment so a search and a pin read the same shape. */
const SEARCH_QUERY = `query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number title url state isDraft createdAt updatedAt author { login } repository { name owner { login } } } }
  }
}`;

type SearchNode = {
  number?: number; title?: string; url?: string; state?: string; isDraft?: boolean; createdAt?: string; updatedAt?: string;
  author?: { login?: string } | null; repository?: { name?: string; owner?: { login?: string } };
};

export function summaryOf(n: SearchNode): PrSummary | null {
  const owner = n.repository?.owner?.login; const repo = n.repository?.name;
  if (typeof n.number !== "number" || !owner || !repo) return null;
  return {
    ref: { owner, repo, number: n.number },
    title: str(n.title), url: str(n.url),
    state: PR_STATE[lower(n.state)] ?? "open", draft: n.isDraft === true,
    author: login(n.author), createdAt: time(n.createdAt), updatedAt: time(n.updatedAt),
  };
}

/** `gh pr view --json` — the fields the Summary tab draws, and only those. */
const DETAIL_FIELDS = [
  "number", "title", "body", "url", "state", "isDraft", "author", "createdAt", "updatedAt",
  "baseRefName", "headRefName", "headRefOid", "headRepositoryOwner", "additions", "deletions", "changedFiles",
  "mergeable", "mergeStateStatus", "reviewDecision", "reviewRequests", "latestReviews", "comments", "statusCheckRollup",
].join(",");

/** Comments kept on the request — the conversation's end. The total is the whole thread's. */
const RECENT_COMMENTS = 5;

const REVIEW_STATE: Record<string, ReviewerState> = {
  approved: "approved", changes_requested: "changes_requested", commented: "commented", dismissed: "dismissed", pending: "pending",
};

/** A check's one word, from either of GitHub's two shapes: a CheckRun's conclusion (or its status
 *  while it runs), a StatusContext's state. */
function checkState(c: { status?: unknown; conclusion?: unknown; state?: unknown }): CheckState {
  const word = lower(c.conclusion) || lower(c.state) || lower(c.status);
  if (word === "success") return "success";
  if (["failure", "error", "timed_out", "cancelled", "action_required", "startup_failure", "stale"].includes(word)) return "failure";
  if (word === "skipped") return "skipped";
  if (word === "neutral") return "neutral";
  return "pending";
}

type DetailJson = {
  number?: number; title?: string; body?: string; url?: string; state?: string; isDraft?: boolean; author?: unknown;
  createdAt?: string; updatedAt?: string; baseRefName?: string; headRefName?: string; headRefOid?: string; headRepositoryOwner?: unknown;
  additions?: number; deletions?: number; changedFiles?: number; mergeable?: string; mergeStateStatus?: string; reviewDecision?: string;
  reviewRequests?: { __typename?: string; login?: string; name?: string; slug?: string }[];
  latestReviews?: { author?: unknown; state?: string }[];
  comments?: { author?: unknown; body?: string; createdAt?: string; url?: string }[];
  statusCheckRollup?: { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string }[];
};

export function detailOf(ref: PrRef, d: DetailJson): PrDetail {
  const reviewed = (d.latestReviews ?? []).flatMap((r) => {
    const name = login(r.author);
    return name ? [{ name, team: false, state: REVIEW_STATE[lower(r.state)] ?? "commented" }] : [];
  });
  // A reviewer asked again after reviewing is still owed a review: the request is the newer fact.
  const requested = (d.reviewRequests ?? []).flatMap((r) => {
    const team = r.__typename === "Team" || (!r.login && !!(r.slug ?? r.name));
    const name = team ? str(r.slug) || str(r.name) : str(r.login);
    return name ? [{ name, team, state: "pending" as const }] : [];
  });
  const reviewers = [...requested, ...reviewed.filter((r) => !requested.some((q) => !q.team && q.name.toLowerCase() === r.name.toLowerCase()))];
  const comments = d.comments ?? [];
  const decision = lower(d.reviewDecision);
  const mergeable = lower(d.mergeable);
  return {
    ref,
    title: str(d.title), url: str(d.url), body: str(d.body),
    state: PR_STATE[lower(d.state)] ?? "open", draft: d.isDraft === true,
    author: login(d.author), createdAt: time(d.createdAt), updatedAt: time(d.updatedAt),
    base: str(d.baseRefName), head: str(d.headRefName), headSha: str(d.headRefOid),
    headOwner: (() => { const o = login(d.headRepositoryOwner); return o && o.toLowerCase() !== ref.owner.toLowerCase() ? o : null; })(),
    additions: d.additions ?? 0, deletions: d.deletions ?? 0, changedFiles: d.changedFiles ?? 0,
    mergeable: mergeable === "mergeable" ? "mergeable" : mergeable === "conflicting" ? "conflicting" : "unknown",
    mergeState: lower(d.mergeStateStatus) || "unknown",
    decision: decision === "approved" || decision === "changes_requested" || decision === "review_required" ? decision : null,
    reviewers,
    comments: {
      total: comments.length,
      recent: comments.slice(-RECENT_COMMENTS).map((c) => ({ author: login(c.author), body: str(c.body), createdAt: time(c.createdAt), url: str(c.url) || null })),
    },
    checks: (d.statusCheckRollup ?? []).map((c) => ({
      name: str(c.name) || str(c.context) || "Check",
      state: checkState(c),
      url: str(c.detailsUrl) || str(c.targetUrl) || null,
    })),
  };
}

/** GitHub's REST file statuses, in the contract's words. */
const FILE_STATUS: Record<string, PrFileStatus> = {
  added: "added", modified: "modified", removed: "deleted", renamed: "renamed", copied: "copied", changed: "changed", unchanged: "modified",
};

type FileJson = { filename?: string; previous_filename?: string; status?: string; additions?: number; deletions?: number; patch?: string };
/** One changed file and its raw patch — the hunks only, as GitHub sends them (no `diff --git` head),
 *  or null where GitHub sent none. */
export type RawFile = { file: PrFile; patch: string | null };

export function fileOf(f: FileJson): RawFile | null {
  if (typeof f.filename !== "string" || f.filename === "") return null;
  const additions = f.additions ?? 0, deletions = f.deletions ?? 0;
  const patch = typeof f.patch === "string" && f.patch !== "" ? f.patch : null;
  return {
    file: {
      path: f.filename, oldPath: typeof f.previous_filename === "string" ? f.previous_filename : null,
      status: FILE_STATUS[lower(f.status)] ?? "modified", additions, deletions,
      // A file GitHub counted lines for but sent no patch of is one it judged too big to send.
      patch: patch ? "text" : additions + deletions > 0 ? "too-large" : "none",
    },
    patch,
  };
}

/** A repository path's segments, each escaped, for a REST route: a file named `a#b` or `50%.md`
 *  must reach GitHub as itself. */
const routePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");
const repoRoute = (ref: PrRef): string => `repos/${ref.owner}/${ref.repo}`;

/** Pages of the files endpoint fetched at once: enough to read a big change in a few round trips,
 *  few enough not to be a burst GitHub's secondary rate limit notices. */
const FILE_PAGE_CONCURRENCY = 4;
const FILES_PER_PAGE = 100;
/** A file's text, read for opening an unchanged band; past this it is not a file to read in a diff. */
const FILE_TEXT_MAX = 2 * 1024 * 1024;

/**
 * Everything Realm asks `gh`, as typed calls. Stateless: caching is the service's, so this can be
 * driven call by call against a fake `gh` and its argv asserted exactly.
 */
export class GhClient {
  constructor(private readonly run: GhRun) {}

  /** Who `gh` is signed in as — `gh api user` is the one call that needs auth and answers in a
   *  single request, so its failure is the clearest reading of the three states it can be in. */
  async status(): Promise<GhStatus> {
    const r = await this.run(["api", "user"]);
    if (r.code === 127) return { state: "missing", login: null, reason: null };
    if (r.code === 0) {
      try {
        const user = JSON.parse(r.stdout) as { login?: unknown };
        if (typeof user.login === "string") return { state: "ready", login: user.login, reason: null };
      } catch { /* falls through: an answer nobody can read is not a sign-in */ }
      return { state: "unreachable", login: null, reason: "gh answered with something that is not an account" };
    }
    if (signedOut(r)) return { state: "signed-out", login: null, reason: null };
    return { state: "unreachable", login: null, reason: firstLine(r.stderr) || `gh exited with ${r.code}` };
  }

  /** One page of a GitHub search for pull requests. */
  async search(q: string, first: number, after: string | null): Promise<PrPage> {
    const args = ["api", "graphql", "-f", `query=${SEARCH_QUERY}`, "-f", `q=${q}`, "-F", `first=${first}`];
    if (after) args.push("-f", `after=${after}`);
    const body = json<{ data?: { search?: { issueCount?: number; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: SearchNode[] } }; errors?: { message?: string }[] }>(await this.run(args));
    const found = body.data?.search;
    if (!found) throw new RpcError("GH_FAILED", body.errors?.[0]?.message ?? "GitHub's search did not answer");
    return {
      prs: (found.nodes ?? []).map(summaryOf).filter((p): p is PrSummary => p !== null),
      nextCursor: found.pageInfo?.hasNextPage && found.pageInfo.endCursor ? found.pageInfo.endCursor : null,
      total: found.issueCount ?? 0,
    };
  }

  async detail(ref: PrRef): Promise<PrDetail> {
    const d = json<DetailJson>(await this.run(["pr", "view", String(ref.number), "--repo", `${ref.owner}/${ref.repo}`, "--json", DETAIL_FIELDS]));
    return detailOf(ref, d);
  }

  /**
   * Every changed file of the request and its patch, page by page — GitHub lists at most 3000, a
   * hundred to a page. `changedFiles` (from the detail) says how many pages there are, so they are
   * asked for together rather than one waiting on the last.
   */
  async files(ref: PrRef, changedFiles: number): Promise<{ files: RawFile[]; truncated: boolean }> {
    const pages = Math.max(1, Math.ceil(Math.min(changedFiles, PR_FILES_MAX) / FILES_PER_PAGE));
    const out: RawFile[][] = new Array(pages);
    let next = 0;
    const worker = async () => {
      for (let p = next++; p < pages; p = next++) {
        const page = json<FileJson[]>(await this.run(["api", `${repoRoute(ref)}/pulls/${ref.number}/files?per_page=${FILES_PER_PAGE}&page=${p + 1}`]));
        out[p] = (Array.isArray(page) ? page : []).map(fileOf).filter((f): f is RawFile => f !== null);
      }
    };
    await Promise.all(Array.from({ length: Math.min(FILE_PAGE_CONCURRENCY, pages) }, worker));
    return { files: out.flat(), truncated: changedFiles > PR_FILES_MAX };
  }

  /** A file's text at `sha`, split into lines — null for one that is not text or too big to read. */
  async fileLines(ref: PrRef, sha: string, path: string): Promise<string[] | null> {
    const r = await this.run(["api", "-H", "Accept: application/vnd.github.raw+json", `${repoRoute(ref)}/contents/${routePath(path)}?ref=${encodeURIComponent(sha)}`]);
    if (r.code !== 0) {
      const e = failure(r);
      if (e.code === "PR_NOT_FOUND") return null; // the file at that head is gone, or never was
      throw e;
    }
    if (r.stdout.length > FILE_TEXT_MAX || r.stdout.includes("\u0000")) return null;
    const lines = r.stdout.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  }

  /**
   * Post a review: the one write. The body goes on stdin as JSON (`--input -`), so a comment of any
   * length or punctuation reaches GitHub as written, with no shell or field syntax in between. Line
   * comments ride in the same request, so the review lands whole or not at all.
   */
  async submit(review: SubmitReview): Promise<SubmittedReview> {
    const payload = {
      commit_id: review.headSha,
      event: review.event,
      body: review.body,
      ...(review.comments.length > 0 ? { comments: review.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })) } : {}),
    };
    const r = await this.run(["api", "--method", "POST", `${repoRoute(review.ref)}/pulls/${review.ref.number}/reviews`, "--input", "-"], { input: JSON.stringify(payload) });
    if (r.code !== 0) {
      const e = failure(r);
      // GitHub's 422 is the review it refused, and why — say so in those words.
      throw e.code === "GH_FAILED" ? new RpcError("REVIEW_REFUSED", `GitHub did not post the review: ${e.message}`) : e;
    }
    try {
      const posted = JSON.parse(r.stdout) as { id?: unknown; html_url?: unknown };
      return { id: typeof posted.id === "number" ? posted.id : null, url: typeof posted.html_url === "string" ? posted.html_url : null };
    } catch { return { id: null, url: null }; }
  }
}
