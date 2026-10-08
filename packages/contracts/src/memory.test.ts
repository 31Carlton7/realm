import { describe, expect, it } from "vitest";
import {
  MEMORY_REPO_INITIAL_INDEX, amrRepoSourceLink, applyMemoryEdit, formatMemoryEntry, memoryEntryProblem, memorySupportNote,
  parseMemoryEntry, wikiLinkFor, wikiLinkTarget, withIndexLink,
} from "./memory";

describe("memorySupportNote", () => {
  it("always names the agent, so a note rendered for the wrong session is visibly wrong", () => {
    expect(memorySupportNote("claude")).toContain("Claude");
    expect(memorySupportNote("codex")).toContain("Codex");
    expect(memorySupportNote("acp:cursor")).toContain("Cursor");
  });

  it("states the Cursor reality outright rather than hedging", () => {
    expect(memorySupportNote("acp:cursor")).toMatch(/no per-session context/);
    // ...and where its memory DOES come from, once a repo is attached.
    expect(memorySupportNote("acp:cursor")).toMatch(/memory tools/);
  });
});

describe("memory entries (Agent Memory Repo format)", () => {
  it("reads the spec's own examples", () => {
    expect(parseMemoryEntry("- John coordinates the billing launch [source: https://example.com/sessions/101]")).toEqual({
      text: "John coordinates the billing launch", meta: { source: "https://example.com/sessions/101" },
    });
    expect(parseMemoryEntry("- Payments and website share a 2026-10-15 launch deadline [source: https://example.com/sessions/102; added: 2026-09-03]")).toEqual({
      text: "Payments and website share a 2026-10-15 launch deadline", meta: { source: "https://example.com/sessions/102", added: "2026-09-03" },
    });
    expect(parseMemoryEntry("- Prefers summaries as short bullet lists")).toEqual({ text: "Prefers summaries as short bullet lists", meta: {} });
  });

  it("keeps a `:` and a `;` inside a URL in its value", () => {
    const e = { text: "The dashboard", meta: { source: "https://grafana.example.com/d/x?a=1;b=2&c=http://y", added: "2026-10-08" } };
    // THE MUTANT: split the bracket on every `;` — the URL is cut at `;b=2` and the pair after it no
    // longer parses, so the whole tail is read back as part of the fact.
    expect(parseMemoryEntry(formatMemoryEntry(e))).toEqual(e);
  });

  it("round-trips open keys and leaves a bracket that is not metadata in the fact", () => {
    const e = { text: "Deploys go through [[runbooks/deploy]]", meta: { source: "realm:session/01ABC", confidence: "high" } };
    expect(parseMemoryEntry(formatMemoryEntry(e))).toEqual(e);
    expect(parseMemoryEntry("- Read the notes [see appendix]")).toEqual({ text: "Read the notes [see appendix]", meta: {} });
    expect(parseMemoryEntry("Not a bullet")).toBeNull();
  });

  it("refuses an entry that would not read back as written", () => {
    expect(memoryEntryProblem({ text: "fine", meta: { added: "2026-10-08" } })).toBeNull();
    expect(memoryEntryProblem({ text: "two\nlines", meta: {} })).toMatch(/one line/);
    expect(memoryEntryProblem({ text: "x", meta: { source: "a]b" } })).toMatch(/square brackets/);
    expect(memoryEntryProblem({ text: "ends in [k: v]", meta: {} })).toMatch(/read back/);
  });
});

describe("cross-links", () => {
  it("resolves [[path]] from the repo root, adding .md only where there is no extension", () => {
    expect(wikiLinkTarget("[[projects/payments]]")).toBe("projects/payments.md");
    // THE MUTANT: always append `.md` — the spec's `.sql` example then points at a file that is not there.
    expect(wikiLinkTarget("[[metrics/autocomplete_keep_rate.sql]]")).toBe("metrics/autocomplete_keep_rate.sql");
    expect(wikiLinkTarget("team_structure")).toBe("team_structure.md");
    expect(wikiLinkTarget("[[]]")).toBeNull();
    expect(wikiLinkFor("projects/payments.md")).toBe("[[projects/payments]]");
    expect(wikiLinkFor("metrics/x.sql")).toBe("[[metrics/x.sql]]");
  });

  it("adds an index link under ## Index once", () => {
    const once = withIndexLink("# Memory\n\n- a fact\n\n## Index\n- [[team]]\n", "projects/payments.md");
    expect(once).toBe("# Memory\n\n- a fact\n\n## Index\n- [[team]]\n- [[projects/payments]]\n");
    expect(withIndexLink(once, "projects/payments.md")).toBe(once);
    expect(withIndexLink("# Memory\n", "a.md")).toBe("# Memory\n\n## Index\n- [[a]]\n");
  });
});

describe("applyMemoryEdit", () => {
  const entry = (text: string) => ({ text, meta: { added: "2026-10-08" } });

  it("puts a MEMORY.md fact above ## Index, and a topic fact at the end", () => {
    const a = applyMemoryEdit(MEMORY_REPO_INITIAL_INDEX, { op: "add", entry: entry("Prefers tabs") }, { isIndex: true, title: "MEMORY" });
    expect(a).toEqual({ ok: true, changed: true, content: "# Memory\n\n- Prefers tabs [added: 2026-10-08]\n\n## Index\n" });
    const b = applyMemoryEdit(a.ok ? a.content : "", { op: "add", entry: entry("Uses pnpm") }, { isIndex: true, title: "MEMORY" });
    expect(b.ok && b.content).toBe("# Memory\n\n- Prefers tabs [added: 2026-10-08]\n- Uses pnpm [added: 2026-10-08]\n\n## Index\n");
    const t = applyMemoryEdit("", { op: "add", entry: entry("Ships Fridays") }, { isIndex: false, title: "payments" });
    expect(t.ok && t.content).toBe("# payments\n\n- Ships Fridays [added: 2026-10-08]\n");
  });

  it("does not add a fact twice", () => {
    const content = "- Prefers tabs [added: 2026-01-01]\n";
    expect(applyMemoryEdit(content, { op: "add", entry: entry("Prefers tabs") }, { isIndex: false, title: "x" })).toEqual({ ok: true, content, changed: false });
  });

  it("replaces and removes exactly one entry, and says so when the match is not one", () => {
    const content = "# t\n\n- Deploys on Friday [added: 2026-01-01]\n- Deploys need a review [added: 2026-01-01]\n";
    const r = applyMemoryEdit(content, { op: "replace", match: "Deploys on Friday", entry: entry("Deploys on Thursday") }, { isIndex: false, title: "t" });
    expect(r.ok && r.content).toBe("# t\n\n- Deploys on Thursday [added: 2026-10-08]\n- Deploys need a review [added: 2026-01-01]\n");
    const many = applyMemoryEdit(content, { op: "remove", match: "deploys" }, { isIndex: false, title: "t" });
    // THE MUTANT: take the first substring hit — "forget the deploy day" then deletes the review rule.
    expect(many.ok).toBe(false);
    expect(!many.ok && many.error).toMatch(/2 entries match/);
    const none = applyMemoryEdit(content, { op: "remove", match: "standup" }, { isIndex: false, title: "t" });
    expect(!none.ok && none.error).toMatch(/no entry matches/);
    const gone = applyMemoryEdit(content, { op: "remove", match: "- Deploys need a review [added: 2026-01-01]" }, { isIndex: false, title: "t" });
    expect(gone.ok && gone.content).toBe("# t\n\n- Deploys on Friday [added: 2026-01-01]\n");
  });

  it("stamps nothing itself — the source link is the server's", () => {
    expect(amrRepoSourceLink("01ABC")).toBe("realm:session/01ABC");
  });
});
