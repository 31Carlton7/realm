import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";

/** The fake `gh` the live checks run too (scripts/fixtures/fake-gh.mjs). */
const FAKE_GH = fileURLToPath(new URL("../../scripts/fixtures/fake-gh.mjs", import.meta.url));

export type GhCall = { args: string[]; stdin: string | null };
export type FakeGh = { command: string; calls: () => GhCall[]; set: (fixture: GhFixture) => void };

/** A fixture in gh's own shapes (see fake-gh.mjs). Kept loose: the point of a fake is to say
 *  exactly what GitHub would, including the shapes the parsers must survive. */
export type GhFixture = {
  auth?: "ready" | "signed-out" | "offline";
  user?: { login: string };
  sections?: Partial<Record<"authored" | "review" | "team", string[]>>;
  prs: Record<string, { node: Record<string, unknown>; view: Record<string, unknown>; files: Record<string, unknown>[]; contents?: Record<string, string> }>;
  refuseReview?: Record<string, unknown>;
  reviewId?: number;
};

/**
 * A `gh` on disk that answers from `fixture` and records every call — a shell wrapper naming node
 * and the fake by absolute path, so nothing about the test machine's PATH (or its real, signed-in
 * `gh`) can be what answers.
 */
export function fakeGh(fixture: GhFixture): FakeGh {
  const dir = tempDir("realm-fake-gh-");
  const fixturePath = join(dir, "fixture.json");
  const log = join(dir, "calls.jsonl");
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const command = join(dir, "gh");
  writeFileSync(command, `#!/bin/sh\nFAKE_GH_FIXTURE='${fixturePath}' FAKE_GH_LOG='${log}' exec '${process.execPath}' '${FAKE_GH}' "$@"\n`);
  chmodSync(command, 0o755);
  return {
    command,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as GhCall) : []),
    set: (next) => writeFileSync(fixturePath, JSON.stringify(next)),
  };
}

const iso = (day: number) => `2026-10-0${day}T10:00:00Z`;

/** One request in gh's shapes, small enough to read in a test. */
export function pr(owner: string, repo: string, number: number, over: {
  title?: string; author?: string | null; state?: string; draft?: boolean; files?: Record<string, unknown>[]; view?: Record<string, unknown>;
  contents?: Record<string, string>;
} = {}) {
  const title = over.title ?? `Change ${number}`;
  const url = `https://github.com/${owner}/${repo}/pull/${number}`;
  const author = over.author === undefined ? { login: "mara" } : over.author === null ? null : { login: over.author };
  const files = over.files ?? [];
  return {
    node: { number, title, url, state: over.state ?? "OPEN", isDraft: over.draft ?? false, createdAt: iso(1), updatedAt: iso(3), author, repository: { name: repo, owner: { login: owner } } },
    view: {
      number, title, url, body: "", state: over.state ?? "OPEN", isDraft: over.draft ?? false, author, createdAt: iso(1), updatedAt: iso(3),
      baseRefName: "main", headRefName: "feature", headRefOid: "abc1234def5678abc1234def5678abc1234def56", headRepositoryOwner: { login: owner },
      additions: 0, deletions: 0, changedFiles: files.length, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "",
      reviewRequests: [], latestReviews: [], comments: [], statusCheckRollup: [],
      ...over.view,
    },
    files,
    ...(over.contents ? { contents: over.contents } : {}),
  };
}

/** A two-hunk patch: line 2 changed, line 21 added — anchors at RIGHT 1–3 and 18–21, LEFT 1–3 and 18–20. */
export const PATCH = "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n@@ -18,3 +18,4 @@\n eighteen\n nineteen\n twenty\n+twenty-one";
