import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { MemorySearch, stem, terms } from "./search";

/** A memory repo on disk from `rel path → content`. No git: search reads files, nothing else. */
function corpus(files: Record<string, string>): string {
  const root = tempDir("realm-memory-search-");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const fact = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n---\n\n${body}\n`;

/** The owner's kind of memory, small: an AMR root, one space's Claude-format folder, and files that
 *  are noisy on purpose — the ones with the most raw hits for a query are not the answer to it. */
const REPO = {
  "MEMORY.md": "# Memory\n\n- The user ships on Mondays\n- Prefers pnpm over npm\n\n## Index\n- [[spaces/realm/MEMORY]]\n",
  "spaces/realm/MEMORY.md": [
    "- [Headless release recipe](headless-release.md) — source the signing env, sign and notarize the dmg, rewrite its hash",
    "- [Rebuild before live checks](rebuild-before-live-checks.md) — live scripts boot the BUILT app",
    "- [Fresh worktree: build pixel-office types](fresh-worktree-pixel-office.md) — typecheck fails until its dist is built",
    "- [Prompt cache misses](prompt-cache.md) — a changing prefix costs the cache",
  ].join("\n"),
  "spaces/realm/headless-release.md": fact("Headless release recipe", "How to sign and notarize a release from a headless shell",
    "Source ~/.config/realm-signing.env first. The dmg is signed, notarized, and its hash rewritten in latest-mac.yml."),
  "spaces/realm/release-history.md": fact("Release history", "Every version that went out",
    Array.from({ length: 14 }, (_, i) => `- Release 2.${i}.0 went out; the release notes for the release are in CHANGELOG (release ${i}).`).join("\n") +
    "\n- Signing was skipped on one release."),
  "spaces/realm/rebuild-before-live-checks.md": fact("Rebuild before live checks", "The live scripts boot the built app",
    "Run pnpm build first, or a live check tests the previous build."),
  "spaces/realm/fresh-worktree-pixel-office.md": fact("Fresh worktree: build pixel-office types", "Typecheck fails on @realm/pixel-office until its dist is built",
    "Not a code bug: build the package once."),
  "spaces/realm/prompt-cache.md": fact("Prompt cache misses", "A prefix that changes between requests misses the prompt cache",
    "Keep the system prompt byte-identical across restarts."),
  "spaces/realm/cache-and-prompts.md": fact("Disk cache", "Where build caches live",
    "The cache for images is under site/.next/cache. The prompt for clearing it is in the README."),
  "notes/long.md": `# Long note\n\n${"Background that goes on and on. ".repeat(20)}The webhook retries for three days.${" More background.".repeat(20)}\n`,
};

const search = (q: string, files: Record<string, string> = REPO, limit = 10) => {
  const repo = corpus(files);
  return { repo, hits: new MemorySearch().search([repo], q, limit) };
};

describe("ranking", () => {
  it("puts the fact about the query first, not the file that says its words the most", () => {
    // release-history.md says "release" sixteen times and "signing" once; the recipe says each twice.
    const { hits } = search("sign a release");
    expect(hits[0]).toMatchObject({ path: "spaces/realm/headless-release.md" });
    // THE MUTANT: score by raw counts (no saturation, no field weight) — the history file leads.
    expect(hits.findIndex((h) => h.path === "spaces/realm/release-history.md")).toBeGreaterThan(0);
    // Its index line is a close second: the hook was written to be found.
    expect(hits.slice(0, 3).map((h) => h.path)).toContain("spaces/realm/MEMORY.md");
  });

  it("weighs a file's name and description over its body", () => {
    // "Rebuild" and "live" are in the rebuild fact's title; the release history mentions neither, the
    // long note neither — but "build" is in three bodies.
    const { hits } = search("rebuild live check");
    expect(hits[0]!.path).toBe("spaces/realm/rebuild-before-live-checks.md");
  });

  it("boosts the exact phrase over the same words apart", () => {
    // Both facts hold "prompt" and "cache"; only one holds them as the phrase.
    const { hits } = search("prompt cache");
    const at = (p: string) => hits.findIndex((h) => h.path === p);
    expect(at("spaces/realm/prompt-cache.md")).toBeGreaterThanOrEqual(0);
    // THE MUTANT: no phrase boost — the disk-cache fact, which says "cache" three times, ties or leads.
    expect(at("spaces/realm/prompt-cache.md")).toBeLessThan(at("spaces/realm/cache-and-prompts.md"));
  });

  it("lets a field's weight decide between two files of the same words", () => {
    // The same words in each file, swapped between description and body. Path order would put a.md
    // first; only the description's weight puts b.md there. THE MUTANT: every field weighed alike.
    const files = {
      "a.md": fact("a", "Unrelated words about lunch", "The deploy train leaves on Mondays."),
      "b.md": fact("b", "The deploy train leaves on Mondays", "Unrelated words about lunch."),
    };
    expect(search("deploy train", files).hits.map((h) => h.path)).toEqual(["b.md", "a.md"]);
  });

  it("ranks the shorter of two files that hold the word as often", () => {
    // Each says "webhook" once; long.md says much else besides. Path order would put long.md first.
    // THE MUTANT: no length normalisation (b = 0) — the two tie and long.md leads.
    const files = { "long.md": `The webhook retries.\n${"Unrelated filler about other things. ".repeat(30)}\n`, "short.md": "The webhook retries.\n" };
    expect(search("webhook", files).hits.map((h) => h.path)).toEqual(["short.md", "long.md"]);
  });

  it("puts the line that holds the phrase above the same words in another order", () => {
    // Two index lines with the very same words; only the order differs, and the earlier line is the
    // one without the phrase. THE MUTANT: no phrase boost — they tie and line 1 leads.
    const files = { "MEMORY.md": "- The cache misses when the prompt prefix changes\n- The prompt cache misses when the prefix changes\n" };
    expect(search("prompt cache", files).hits.map((h) => h.line)).toEqual([2, 1]);
  });

  it("prefers a quoted phrase where the query has one", () => {
    const { hits } = search('"cache misses" prompt');
    expect(hits[0]!.path).toMatch(/prompt-cache\.md$|MEMORY\.md$/);
  });
});

describe("matching words the way they are meant", () => {
  it("ignores case and punctuation: pixel-office, Pixel Office and pixeloffice are one term", () => {
    for (const q of ["pixel-office", "Pixel Office", "PIXELOFFICE", "pixel_office"]) {
      const { hits } = search(q);
      expect(hits.map((h) => h.path), q).toContain("spaces/realm/fresh-worktree-pixel-office.md");
    }
  });

  it("folds endings and matches the start of a longer word", () => {
    expect(search("notarization").hits.map((h) => h.path)).toContain("spaces/realm/headless-release.md");
    expect(search("notar").hits.map((h) => h.path)).toContain("spaces/realm/headless-release.md");
    expect(search("webhooks retrying").hits[0]!.path).toBe("notes/long.md");
    expect(search("typechecks").hits.map((h) => h.path)).toContain("spaces/realm/fresh-worktree-pixel-office.md");
  });

  it("answers nothing for a word nothing holds, and nothing for an empty query", () => {
    expect(search("kubernetes").hits).toEqual([]);
    expect(search("  ").hits).toEqual([]);
  });

  it("still searches a query of nothing but common words", () => {
    expect(search("the").hits.length).toBeGreaterThan(0);
  });
});

describe("hits", () => {
  it("names the file and the line that holds the match, with that line as the snippet", () => {
    const { hits } = search("notarize headless shell");
    const recipe = hits.find((h) => h.path === "spaces/realm/headless-release.md")!;
    // The description line of the frontmatter — line 3 of the file — holds the most of the query.
    expect(recipe).toMatchObject({ line: 3, text: "How to sign and notarize a release from a headless shell" });
    const index = hits.find((h) => h.path === "spaces/realm/MEMORY.md")!;
    expect(index).toMatchObject({ line: 1, text: expect.stringMatching(/^- \[Headless release recipe\]/) });
  });

  it("gives each index line its own hit, at its own line", () => {
    const { hits } = search("Mondays pnpm", REPO, 10);
    const root = hits.filter((h) => h.path === "MEMORY.md").map((h) => h.line).sort();
    expect(root).toEqual([3, 4]);
  });

  it("cuts a long line to a window around the match", () => {
    const { hits } = search("webhook retries");
    const long = hits.find((h) => h.path === "notes/long.md")!;
    expect(long.text.length).toBeLessThanOrEqual(300);
    expect(long.text).toContain("webhook retries for three days");
    expect(long.text.startsWith("…")).toBe(true);
  });

  it("keeps the best `limit`, ties settled by path and line so the answer is the same every time", () => {
    const { repo, hits } = search("build", REPO, 3);
    expect(hits).toHaveLength(3);
    expect(new MemorySearch().search([repo], "build", 3)).toEqual(hits);
  });

  it("ranks across repos as one list, each hit naming its repo", () => {
    const mine = corpus({ "MEMORY.md": "- Prefers tabs\n" });
    const team = corpus({ "MEMORY.md": "- Deploys go out from main, never from a branch\n", "deploys.md": "# Deploys\n\nDeploys happen on Mondays.\n" });
    const hits = new MemorySearch().search([mine, team], "deploys from main", 5);
    expect(hits[0]).toMatchObject({ repo: team, path: "MEMORY.md", line: 1 });
    expect(hits.every((h) => h.repo === team)).toBe(true);
  });

  it("finds a file by its path when nothing in it says the words", () => {
    const { hits } = search("ideas backlog", { "notes/ideas-backlog.md": "", "slug.md": "---\nname: slug\n---\n" });
    expect(hits).toEqual([expect.objectContaining({ path: "notes/ideas-backlog.md", line: 1, text: "notes/ideas-backlog.md" })]);
    expect(search("slug", { "slug.md": "---\nname: slug\n---\n" }).hits).toEqual([expect.objectContaining({ path: "slug.md", line: 1 })]);
  });

  it("searches files other than Markdown as plain text", () => {
    const { hits } = search("keep rate", { "metrics/keep_rate.sql": "select count(*) from keeps;\n" });
    expect(hits).toEqual([expect.objectContaining({ path: "metrics/keep_rate.sql" })]);
  });
});

describe("a preferred folder", () => {
  /** The same fact in two space folders, so only the path can tell them apart. */
  const twins = {
    "spaces/a/deploys.md": fact("Deploys", "Deploys go out from main", "Nothing else here."),
    "spaces/b/deploys.md": fact("Deploys", "Deploys go out from main", "Nothing else here."),
  };

  it("lifts the hits under it by half again, and leaves the rest where they were", () => {
    const repo = corpus(twins);
    const finder = new MemorySearch();
    const plain = finder.search([repo], "deploys main", 5);
    // A tie, settled by path.
    expect(plain.map((h) => h.path)).toEqual(["spaces/a/deploys.md", "spaces/b/deploys.md"]);
    expect(plain[0]!.score).toBe(plain[1]!.score);
    const lifted = finder.search([repo], "deploys main", 5, "spaces/b/");
    // THE MUTANT: no lift — the tie stands and a's hit leads.
    expect(lifted.map((h) => h.path)).toEqual(["spaces/b/deploys.md", "spaces/a/deploys.md"]);
    expect(lifted[0]!.score).toBeCloseTo(plain[1]!.score * 1.5, 10);
    // THE MUTANT: a filter — the other folder's hit is gone. It is still there, scored as before.
    expect(lifted[1]!.score).toBe(plain[0]!.score);
  });

  it("is a lift, not a filter: a far better match outside it still leads", () => {
    const repo = corpus({
      "MEMORY.md": "- The release train leaves on Mondays\n",
      "spaces/b/notes.md": `# Notes\n\n${"Background on other things. ".repeat(30)}A train was late once.\n`,
    });
    const hits = new MemorySearch().search([repo], "release train", 5, "spaces/b/");
    expect(hits.map((h) => h.path)).toEqual(["MEMORY.md", "spaces/b/notes.md"]);
  });

  it("changes nothing when there is none, or nothing is under it", () => {
    const repo = corpus(twins);
    const finder = new MemorySearch();
    const plain = finder.search([repo], "deploys main", 5);
    expect(finder.search([repo], "deploys main", 5, "")).toEqual(plain);
    expect(finder.search([repo], "deploys main", 5, "spaces/zzz/")).toEqual(plain);
  });
});

describe("the cache", () => {
  it("re-reads a file only when its mtime or size moved, and forgets a deleted one", () => {
    const repo = corpus({ "a.md": "# A\n\nalpha fact\n", "b.md": "# B\n\nbeta fact\n" });
    // A whole-second mtime, so setting it back after the edit restores it exactly.
    const mtime = new Date("2026-10-01T12:00:00Z");
    utimesSync(join(repo, "a.md"), mtime, mtime);
    const finder = new MemorySearch();
    expect(finder.search([repo], "alpha", 5).map((h) => h.path)).toEqual(["a.md"]);
    // Same size, same mtime: the cache answers, and the edit is not seen — that is what keys it.
    writeFileSync(join(repo, "a.md"), "# A\n\ngamma fact\n");
    utimesSync(join(repo, "a.md"), mtime, mtime);
    expect(statSync(join(repo, "a.md")).mtime.getTime()).toBe(mtime.getTime());
    expect(finder.search([repo], "alpha", 5).map((h) => h.path)).toEqual(["a.md"]);
    // A new mtime: read again.
    utimesSync(join(repo, "a.md"), new Date(mtime.getTime() + 5_000), new Date(mtime.getTime() + 5_000));
    expect(finder.search([repo], "alpha", 5)).toEqual([]);
    expect(finder.search([repo], "gamma", 5).map((h) => h.path)).toEqual(["a.md"]);
    rmSync(join(repo, "b.md"));
    expect(finder.search([repo], "beta", 5)).toEqual([]);
  });
});

describe("terms", () => {
  it("folds a word's forms to one stem", () => {
    for (const [a, b] of [["webhooks", "webhook"], ["caching", "cache"], ["cached", "caches"], ["retried", "retries"], ["running", "run"], ["stopped", "stop"]]) {
      expect(stem(a!), `${a} ~ ${b}`).toBe(stem(b!));
    }
    expect(stem("status")).toBe("status");
    expect(stem("process")).toBe("process");
  });

  it("splits at punctuation and camelCase, and with compounds keeps the run-together form too", () => {
    expect(terms("indexesFor")).toEqual([stem("indexes"), "for"]);
    expect(terms("pixel-office", { compounds: true })).toEqual(["pixel", stem("office"), stem("pixeloffice")]);
    expect(terms("Café", {})).toEqual(["caf"]);
  });
});
