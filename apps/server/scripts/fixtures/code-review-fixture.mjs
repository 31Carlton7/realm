/**
 * The pull requests the Code Review live checks serve through `fake-gh.mjs` — never GitHub's.
 *
 *   node code-review-fixture.mjs <out.json>     writes the fixture
 *   import { buildFixture } from "./code-review-fixture.mjs"
 *
 * acme/widgets#42 is the one the checks open: seven files across every kind GitHub reports (modified,
 * added, deleted, a binary with no patch, a generated file long enough to scroll), with its patches
 * made by a real `git diff --no-index` so every hunk header and line number is one git wrote. The
 * fake agent's scripted review (apps/server/src/app.ts) comments on two of its lines and one line
 * its diff does not show. #38 is wide — 360 files — for the virtualised list; the rest fill the
 * three lists past a page, so Show more has something to show.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const HEAD = "9f2c4e1a7b3d5c6e8f0a1b2c3d4e5f6a7b8c9d0e";

const TOKENIZER_OLD = `import { Token, TokenKind } from "./token";

/** Turns source text into tokens, reading the whole input into one buffer first. */
const BUFFER_SIZE = 64 * 1024;

export class Tokenizer {
  private buffer = "";
  private line = 1;

  constructor(private readonly source: string) {
    this.buffer = source.slice(0, BUFFER_SIZE);
  }

  *tokens(): Iterable<Token> {
    let i = 0;
    while (i < this.buffer.length) {
      const ch = this.buffer[i]!;
      if (ch === "\\n") { this.line++; i++; continue; }
      if (/\\s/.test(ch)) { i++; continue; }
      const end = this.wordEnd(this.buffer, i);
      yield { kind: TokenKind.Word, text: this.buffer.slice(i, end), line: this.line };
      i = end;
    }
  }

  private wordEnd(text: string, from: number): number {
    let j = from;
    while (j < text.length && !/\\s/.test(text[j]!)) j++;
    return j;
  }
}
`;
const TOKENIZER_NEW = `import { Token, TokenKind } from "./token";

/**
 * Turns source text into tokens. Fed in chunks rather than handed the whole input, so a large file
 * never has to sit in memory at once.
 */
export class Tokenizer {
  private pending = "";
  private line = 1;

  /** Take the next chunk and yield every token it completes. */
  *feed(chunk: string): Iterable<Token> {
    const text = this.pending + chunk;
    this.pending = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\\n") { this.line++; i++; continue; }
      if (/\\s/.test(ch)) { i++; continue; }
      const end = this.wordEnd(text, i);
      yield { kind: TokenKind.Word, text: text.slice(i, end), line: this.line };
      i = end;
    }
  }

  /** Whatever the last chunk left unfinished. */
  *end(): Iterable<Token> {
    if (this.pending) yield { kind: TokenKind.Word, text: this.pending, line: this.line };
    this.pending = "";
  }

  private wordEnd(text: string, from: number): number {
    let j = from;
    while (j < text.length && !/\\s/.test(text[j]!)) j++;
    return j;
  }
}
`;
const PARSER_OLD = `import { Tokenizer } from "./tokenizer";
import { Token, TokenKind } from "./token";

export class UnterminatedString extends Error {}

export type Node = { kind: "word"; text: string } | { kind: "string"; text: string };

/** Parse a whole source into nodes. */
export function parse(source: string): Node[] {
  const tokenizer = new Tokenizer(source);
  const nodes: Node[] = [];
  for (const token of tokenizer.tokens()) nodes.push(nodeOf(token));
  return nodes;
}

function nodeOf(token: Token): Node {
  if (token.kind === TokenKind.Word) return { kind: "word", text: token.text };
  return readString(token);
}

function readString(token: Token): Node {
  const text = token.text;
  if (!text.startsWith('"')) return { kind: "word", text };
  let end = 1;
  while (end < text.length && text[end] !== '"') {
    if (text[end] === "\\\\") end++;
    end++;
  }
  // A string that never closes is a mistake in the source, and the reader should hear about it
  // with the line it started on, not find a node that swallowed the rest of the file.
  if (end >= text.length) throw new UnterminatedString(\`string on line \${token.line} never closes\`);
  return { kind: "string", text: text.slice(1, end) };
}
`;
const PARSER_NEW = `import { Tokenizer } from "./tokenizer";
import { Token, TokenKind } from "./token";

export type Node = { kind: "word"; text: string } | { kind: "string"; text: string };

/** Parse a source, fed to the tokenizer in chunks, into nodes. */
export function parse(chunks: Iterable<string>): Node[] {
  const tokenizer = new Tokenizer();
  const nodes: Node[] = [];
  for (const chunk of chunks) for (const token of tokenizer.feed(chunk)) nodes.push(nodeOf(token));
  for (const token of tokenizer.end()) nodes.push(nodeOf(token));
  return nodes;
}

function nodeOf(token: Token): Node {
  if (token.kind === TokenKind.Word) return { kind: "word", text: token.text };
  return readString(token);
}

function readString(token: Token): Node {
  const text = token.text;
  if (!text.startsWith('"')) return { kind: "word", text };
  let end = 1;
  while (end < text.length && text[end] !== '"') {
    if (text[end] === "\\\\") end++;
    end++;
  }
  return { kind: "string", text: text.slice(1, end) };
}
`;
const TEST_NEW = `import { describe, expect, it } from "vitest";
import { Tokenizer } from "../src/tokenizer";

const words = (chunks: string[]) => {
  const t = new Tokenizer();
  return [...chunks.flatMap((c) => [...t.feed(c)]), ...t.end()].map((tok) => tok.text);
};

describe("Tokenizer", () => {
  it("reads one chunk the way it read the whole input", () => {
    expect(words(["let a = b"])).toEqual(["let", "a", "=", "b"]);
  });

  it("counts lines across chunks", () => {
    const t = new Tokenizer();
    const toks = [...t.feed("a\\nb"), ...t.feed("\\nc"), ...t.end()];
    expect(toks.map((tok) => tok.line)).toEqual([1, 2, 3]);
  });

  it("does not grow a buffer with the input", () => {
    const t = new Tokenizer();
    for (let i = 0; i < 1000; i++) [...t.feed("word ".repeat(100))];
    expect([...t.end()]).toEqual([]);
  });
});
`;
const README_OLD = `# widgets

A tiny language toolkit: a tokenizer, a parser, and nothing else.

## How it works

The tokenizer reads the whole input into a 64 KB buffer, then hands tokens to the parser one at a
time. Inputs larger than the buffer are cut off.

## Install

    npm install @acme/widgets@1

## Licence

MIT
`;
const README_NEW = README_OLD.replace("@acme/widgets@1", "@acme/widgets@2");
const LEGACY_OLD = `/** The fixed read buffer the tokenizer filled before it could stream. */
export const BUFFER_SIZE = 64 * 1024;

export function fill(source: string): string {
  return source.slice(0, BUFFER_SIZE);
}
`;
const keywords = (n) => `/* Generated by scripts/keywords.ts — do not edit. */\nexport const KEYWORDS = [\n${Array.from({ length: n }, (_, i) => `  "kw${String(i).padStart(3, "0")}",`).join("\n")}\n] as const;\n`;

/** GitHub's patch for one change: git's own hunks, without the `diff --git` head it never sends. */
function patchOf(dir, before, after) {
  const a = join(dir, "a"), b = join(dir, "b");
  writeFileSync(a, before ?? "");
  writeFileSync(b, after ?? "");
  const r = spawnSync("git", ["diff", "--no-index", "--no-color", "-U3", "--", before === null ? "/dev/null" : a, after === null ? "/dev/null" : b], { encoding: "utf8" });
  const out = r.stdout;
  return out.slice(out.indexOf("@@")).replace(/\n$/, "");
}
const count = (patch, sign) => patch.split("\n").filter((l) => l.startsWith(sign) && !l.startsWith(`${sign}${sign}${sign}`)).length;

function file(dir, path, status, before, after, extra = {}) {
  const patch = patchOf(dir, before, after);
  return { filename: path, status, additions: count(patch, "+"), deletions: count(patch, "-"), changes: count(patch, "+") + count(patch, "-"), patch, ...extra };
}

const iso = (daysAgo, hour = 10) => new Date(Date.UTC(2026, 9, 5 - daysAgo, hour, 12)).toISOString();

function entry({ owner, repo, number, title, author, daysAgo, draft = false, body = "", files = [], view = {}, contents }) {
  const additions = files.reduce((n, f) => n + f.additions, 0), deletions = files.reduce((n, f) => n + f.deletions, 0);
  const url = `https://github.com/${owner}/${repo}/pull/${number}`;
  return {
    node: { number, title, url, state: "OPEN", isDraft: draft, createdAt: iso(daysAgo + 2), updatedAt: iso(daysAgo), author: { login: author }, repository: { name: repo, owner: { login: owner } } },
    view: {
      number, title, body, url, state: "OPEN", isDraft: draft, author: { login: author, name: author },
      createdAt: iso(daysAgo + 2), updatedAt: iso(daysAgo), baseRefName: "main", headRefName: `${author}/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`,
      headRefOid: HEAD, headRepositoryOwner: { login: owner }, additions, deletions, changedFiles: files.length,
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "REVIEW_REQUIRED",
      reviewRequests: [], latestReviews: [], comments: [], statusCheckRollup: [],
      ...view,
    },
    files,
    ...(contents ? { contents } : {}),
  };
}

export function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), "realm-cr-fixture-"));
  try {
    const main = entry({
      owner: "acme", repo: "widgets", number: 42, author: "mara-lin", daysAgo: 0,
      title: "Stream the tokenizer instead of buffering its input",
      body: [
        "## Summary", "",
        "The tokenizer read its whole input into a 64 KB buffer and cut anything longer off. It is now fed the input in chunks and yields each token as soon as it is complete, so a file of any size streams through.", "",
        "### Changes", "",
        "- `Tokenizer.feed(chunk)` yields the tokens a chunk completes; `Tokenizer.end()` flushes the last one",
        "- `parse` takes an iterable of chunks instead of one string",
        "- `src/legacy/buffer.ts` is gone with the buffer it held", "",
        "### Testing", "",
        "- New `test/tokenizer.test.ts` feeds the tokenizer across chunk boundaries",
        "- `pnpm test` passes locally",
      ].join("\n"),
      files: [
        file(dir, "src/tokenizer.ts", "modified", TOKENIZER_OLD, TOKENIZER_NEW),
        file(dir, "src/parser.ts", "modified", PARSER_OLD, PARSER_NEW),
        file(dir, "test/tokenizer.test.ts", "added", null, TEST_NEW),
        file(dir, "src/legacy/buffer.ts", "removed", LEGACY_OLD, null),
        file(dir, "README.md", "modified", README_OLD, README_NEW),
        { filename: "assets/logo.png", status: "modified", additions: 0, deletions: 0, changes: 0 },
        file(dir, "src/generated/keywords.ts", "added", null, keywords(240)),
      ],
      view: {
        mergeStateStatus: "BLOCKED",
        reviewRequests: [{ __typename: "User", login: "carlton", name: "Carlton" }, { __typename: "Team", name: "Core", slug: "core" }],
        latestReviews: [{ author: { login: "jo-park" }, state: "COMMENTED", submittedAt: iso(0, 8) }],
        comments: [
          { author: { login: "jo-park" }, body: "Does this change the error for an unterminated string?", createdAt: iso(0, 8), url: "https://github.com/acme/widgets/pull/42#issuecomment-1" },
          { author: { login: "mara-lin" }, body: "It shouldn't — I'll add a test for it.", createdAt: iso(0, 9), url: "https://github.com/acme/widgets/pull/42#issuecomment-2" },
        ],
        statusCheckRollup: [
          { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/widgets/actions/runs/1" },
          { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/acme/widgets/actions/runs/2" },
          { __typename: "StatusContext", context: "coverage", state: "PENDING", targetUrl: "https://example.com/coverage" },
        ],
      },
      contents: { "src/tokenizer.ts": TOKENIZER_NEW, "src/parser.ts": PARSER_NEW, "README.md": README_NEW, "test/tokenizer.test.ts": TEST_NEW },
    });
    const wide = entry({
      owner: "acme", repo: "widgets", number: 38, author: "carlton", daysAgo: 3,
      title: "Regenerate the grammar tables",
      body: "Every table regenerated from the new grammar. No hand edits.",
      files: Array.from({ length: 360 }, (_, i) => file(dir, `grammar/tables/table-${String(i).padStart(3, "0")}.ts`, "modified",
        `export const TABLE_${i} = [${i}, ${i + 1}, ${i + 2}];\n`, `export const TABLE_${i} = [${i}, ${i + 1}, ${i + 2}, ${i + 3}];\n`)),
    });
    const draft = entry({ owner: "acme", repo: "widgets", number: 39, author: "carlton", daysAgo: 6, draft: true, title: "Add a --json flag to the CLI",
      files: [file(dir, "src/cli.ts", "modified", "export const flags = [];\n", "export const flags = [\"--json\"];\n")] });
    const review = [
      ["acme", "site", 118, "jo-park", "Move the docs to the new theme"], ["acme", "site", 117, "sam-ortiz", "Fix the broken anchor links on the API page"],
      ["acme", "api", 902, "ana-reyes", "Rate-limit the search endpoint per token"], ["acme", "api", 899, "jo-park", "Drop the v1 webhooks"],
      ["acme", "mobile", 61, "lee-chen", "Cache avatars on disk"], ["acme", "mobile", 60, "lee-chen", "Ask for notification permission after sign-in"],
      ["acme", "infra", 230, "sam-ortiz", "Pin the base image digests"], ["acme", "infra", 228, "ana-reyes", "Move the nightly job to 3am UTC"],
      ["acme", "api", 897, "mara-lin", "Log the request id on every error"], ["acme", "site", 115, "jo-park", "Add the pricing FAQ"],
      ["acme", "widgets", 41, "lee-chen", "Speed up the parser's string scan"], ["acme", "mobile", 58, "sam-ortiz", "Remember the last tab"],
    ].map(([owner, repo, number, author, title], i) => entry({ owner, repo, number, author, title, daysAgo: i * 9 + 1,
      files: [file(dir, "src/index.ts", "modified", `export const v = ${i};\n`, `export const v = ${i + 1};\n`)] }));
    const team = [
      ["acme", "api", 905, "lee-chen", "Split the billing service out of the monolith"],
      ["acme", "infra", 233, "jo-park", "Turn on the read replica"],
      ["acme", "site", 120, "ana-reyes", "Rewrite the onboarding emails"],
    ].map(([owner, repo, number, author, title], i) => entry({ owner, repo, number, author, title, daysAgo: i * 4 + 2,
      files: [file(dir, "README.md", "modified", "old\n", "new\n")] }));
    const key = (e) => `${e.node.repository.owner.login}/${e.node.repository.name}#${e.node.number}`.toLowerCase();
    const prs = Object.fromEntries([main, wide, draft, ...review, ...team].map((e) => [key(e), e]));
    return {
      auth: "ready",
      user: { login: "carlton", name: "Carlton" },
      sections: { authored: [main, draft, wide].map(key).filter((k) => prs[k].view.author.login === "carlton"), review: [main, ...review].map(key), team: team.map(key) },
      prs,
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Run as a script (not imported): write the fixture where asked.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeFileSync(process.argv[2], JSON.stringify(buildFixture(), null, 2));
