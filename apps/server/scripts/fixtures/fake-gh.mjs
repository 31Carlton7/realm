#!/usr/bin/env node
/**
 * A `gh` that is not gh: it answers the calls the Code Review page makes from a fixture file and
 * never touches a network. The unit tests (code-review/*.test.ts) and both live checks run it in
 * place of the real CLI, so nothing they do can reach GitHub.
 *
 *   FAKE_GH_FIXTURE  the fixture JSON (see code-review-fixture.mjs for the shape)
 *   FAKE_GH_LOG      where each call is appended as one JSON line: { args, stdin, as }
 *
 * It speaks gh's own shapes — GraphQL search nodes, `pr view --json`, the REST files and reviews
 * endpoints — and gh's exit codes: 4 for "authentication required", 1 for everything else.
 *
 * `fixture.accounts` is what `gh auth status --json hosts` lists for github.com, and without it this
 * is a gh that predates the flag. A call made with one of those accounts' tokens in `GH_TOKEN` is that
 * account's: it answers `api user` with its login and the lists with its own `sections`. `as` in the
 * log is that account's login, or null for gh's own — the token itself is never written anywhere.
 */
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(process.env.FAKE_GH_FIXTURE, "utf8"));
const stdin = args.includes("--input") && args[args.indexOf("--input") + 1] === "-" ? readFileSync(0, "utf8") : null;
const tokenOf = (account) => account.token ?? `token-of-${account.login}`;
/** The account this call was sent as, when it carries one of the fixture's tokens. */
const acting = process.env.GH_TOKEN ? (fixture.accounts ?? []).find((a) => tokenOf(a) === process.env.GH_TOKEN) ?? null : null;
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify({ args, stdin, as: acting?.login ?? null })}\n`);

const ok = (value) => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const no = (code, stderr, stdout = "") => ({ code, stdout, stderr: `${stderr}\n` });

/** The flag's value: `-f q=…` → `q`'s value, `--repo x` → x. */
const field = (name) => {
  for (let i = 0; i < args.length - 1; i++) {
    if ((args[i] === "-f" || args[i] === "-F") && args[i + 1].startsWith(`${name}=`)) return args[i + 1].slice(name.length + 1);
  }
  return null;
};
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const pr = (key) => fixture.prs[key.toLowerCase()] ?? null;

function answer() {
  if (args[0] === "auth" && args[1] === "status") {
    if (!fixture.accounts) return no(1, "unknown flag: --json");
    return ok({ hosts: { "github.com": fixture.accounts.map((a, i) => ({
      state: a.state ?? "success", ...(a.error ? { error: a.error } : {}), active: a.active ?? i === 0, host: "github.com", login: a.login,
      tokenSource: a.tokenSource ?? "keyring", scopes: "repo", gitProtocol: "https",
    })) } });
  }
  if (args[0] === "auth" && args[1] === "token") {
    const account = (fixture.accounts ?? []).find((a) => a.login === flag("--user"));
    return account ? ok(`${tokenOf(account)}\n`) : no(1, `no oauth token found for github.com account ${flag("--user")}`);
  }
  if (acting?.revoked) return no(1, "gh: Bad credentials (HTTP 401)", '{"message":"Bad credentials"}');
  if (fixture.auth === "signed-out") return no(4, "To get started with GitHub CLI, please run:  gh auth login");
  if (fixture.auth === "offline") return no(1, "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com");
  const [cmd, sub] = args;

  if (cmd === "api" && sub === "user") return ok(acting ? { login: acting.login } : fixture.user);

  if (cmd === "api" && sub === "graphql") {
    const q = field("q") ?? "";
    const first = Number(field("first") ?? "10");
    const after = field("after");
    // Which of the page's lists this query is, read the way GitHub would read it.
    const section = q.includes("-user-review-requested:@me") ? "team"
      : q.includes("user-review-requested:@me") ? "review"
        : q.includes("author:@me") ? "authored" : null;
    let keys;
    if (section) keys = (acting?.sections ?? fixture.sections)?.[section] ?? [];
    else {
      const words = q.split(/\s+/).filter((w) => w && !w.includes(":")).join(" ").toLowerCase();
      keys = Object.keys(fixture.prs).filter((k) => fixture.prs[k].node.title.toLowerCase().includes(words));
    }
    const start = after ? Number(after.replace(/^o/, "")) : 0;
    const slice = keys.slice(start, start + first);
    return ok({ data: { search: {
      issueCount: keys.length,
      pageInfo: { hasNextPage: start + first < keys.length, endCursor: slice.length ? `o${start + slice.length}` : null },
      nodes: slice.map((k) => pr(k).node),
    } } });
  }

  if (cmd === "pr" && sub === "view") {
    const found = pr(`${flag("--repo")}#${args[2]}`);
    if (!found) return no(1, `GraphQL: Could not resolve to a PullRequest with the number of ${args[2]}. (repository.pullRequest)`);
    return ok(found.view);
  }

  if (cmd === "api") {
    const route = args.find((a, i) => i > 0 && /^repos\//.test(a)) ?? "";
    const files = /^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files\?per_page=(\d+)&page=(\d+)$/.exec(route);
    if (files) {
      const found = pr(`${files[1]}/${files[2]}#${files[3]}`);
      if (!found) return no(1, "gh: Not Found (HTTP 404)", '{"message":"Not Found"}');
      const per = Number(files[4]), page = Number(files[5]);
      return ok(found.files.slice((page - 1) * per, page * per));
    }
    const contents = /^repos\/([^/]+)\/([^/]+)\/contents\/([^?]+)\?ref=(.+)$/.exec(route);
    if (contents) {
      const found = Object.values(fixture.prs).find((p) => p.node.repository.owner.login.toLowerCase() === contents[1].toLowerCase()
        && p.node.repository.name.toLowerCase() === contents[2].toLowerCase() && p.contents);
      const path = contents[3].split("/").map(decodeURIComponent).join("/");
      const text = found?.contents?.[path];
      return text === undefined ? no(1, "gh: Not Found (HTTP 404)", '{"message":"Not Found"}') : ok(text);
    }
    const reviews = flag("--method") === "POST" ? /^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/.exec(route) : null;
    if (reviews) {
      if (fixture.refuseReview) return no(1, "gh: Unprocessable Entity (HTTP 422)", JSON.stringify(fixture.refuseReview));
      const body = JSON.parse(stdin ?? "{}");
      const id = fixture.reviewId ?? 1001;
      return ok({ id, state: body.event === "APPROVE" ? "APPROVED" : body.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED",
        html_url: `https://github.com/${reviews[1]}/${reviews[2]}/pull/${reviews[3]}#pullrequestreview-${id}` });
    }
  }
  return no(1, `fake gh: no answer for ${JSON.stringify(args)}`);
}

// Written, then exited by exit code alone: on macOS a pipe write is asynchronous, and an explicit
// process.exit() can cut a long answer (a page of patches) off mid-JSON.
const r = answer();
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exitCode = r.code;
