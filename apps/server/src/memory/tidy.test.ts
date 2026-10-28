import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { memoryLearningKey } from "@realm/contracts";
import type { MemoryTidyInput } from "@realm/adapters";
import type { MemorySink } from "./sink";
import {
  MemoryTidier, TIDY_EVERY_MS, TIDY_INDEX_MAX, TIDY_SOONEST_MS, TidyDraft, factFields, parseTidyPlan, readSnapshot,
  type TidyOp,
} from "./tidy";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 28, 12);

const fact = (name: string, type: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  node_type: memory\n  type: ${type}\n---\n\n${body}\n`;
const ROOT = "# Memory\n\n- Works in TypeScript [source: realm:session/s0; added: 2026-10-01]\n\n## Index\n- [[spaces/work/MEMORY]]\n- [[spaces/home/MEMORY]]\n";

/** A repo on disk. Every file is three hours old unless named in `recent`, which is ten minutes old. */
function repo(files: Record<string, string>, recent: string[] = []): string {
  const dir = tempDir("realm-tidy-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
    const t = (recent.includes(rel) ? NOW - 10 * MIN : NOW - 3 * HOUR) / 1000;
    utimesSync(join(dir, rel), t, t);
  }
  return dir;
}

/** A store of two spaces: `work` with three project facts that say one thing twice, and `home`. */
const store = (extra: Record<string, string> = {}) => ({
  "MEMORY.md": ROOT,
  "spaces/work/MEMORY.md": [
    "- [Billing owner](billing-owner.md) — Dana owns billing",
    "- [Who runs billing](billing-lead.md) — Dana runs billing",
    "- [Deploy day](deploy-day.md) — ships on Thursdays, and a great deal more words than any index line needs to carry",
    "",
  ].join("\n"),
  "spaces/work/billing-owner.md": fact("billing-owner", "project", "Dana owns billing", "Dana owns billing; ask her before changing invoices."),
  "spaces/work/billing-lead.md": fact("billing-lead", "project", "Dana runs billing", "Dana runs billing."),
  "spaces/work/deploy-day.md": fact("deploy-day", "project", "Ships on Thursdays", "Billing ships on Thursdays."),
  "spaces/home/MEMORY.md": "- [Terse answers](terse.md) — prefers terse answers\n",
  "spaces/home/terse.md": fact("terse", "user", "Prefers terse answers", "Keep answers short; no recaps."),
  ...extra,
});

/** Old facts enough that the pass may delete more than one thing. */
const olds = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`spaces/work/old-${i}.md`, fact(`old-${i}`, "project", `Old ${i}`, `Old fact ${i}.`)]));

const draftOf = (dir: string, folders = ["work", "home"]) => new TidyDraft(readSnapshot(dir, folders), NOW, "2026-10-28");

describe("factFields — Claude's own fact format", () => {
  it("reads the description and the nested type, and the body after the header", () => {
    expect(factFields(fact("x", "feedback", 'Say "why"', "Body line."))).toMatchObject({ description: 'Say "why"', type: "feedback", body: "\nBody line.\n" });
  });

  it("reads a file with no header as all body", () => {
    expect(factFields("just text")).toEqual({ description: null, type: null, front: null, body: "just text" });
  });
});

describe("the deterministic step — facts about the person go to the root", () => {
  it("links a `user` fact from the root index, above its links, with where it came from", () => {
    const d = draftOf(repo(store()));
    expect(d.promote()).toBe(1);
    const root = d.changes().get("MEMORY.md")!;
    expect(root).toBe([
      "# Memory", "",
      "- Works in TypeScript [source: realm:session/s0; added: 2026-10-01]",
      "- Prefers terse answers ([[spaces/home/terse]]) [source: spaces/home/terse.md; added: 2026-10-28]",
      "", "## Index", "- [[spaces/work/MEMORY]]", "- [[spaces/home/MEMORY]]", "",
    ].join("\n"));
    // The space's own file stays where it is: the root links it, it does not move.
    expect(d.changes().has("spaces/home/terse.md")).toBe(false);
  });

  it("leaves project facts, and a feedback fact only one space holds, to the model", () => {
    const d = draftOf(repo(store({ "spaces/work/no-mocks.md": fact("no-mocks", "feedback", "No mocked databases", "Use a real database in tests.") })));
    d.promote();
    expect(d.changes().get("MEMORY.md")).not.toContain("no-mocks");
    expect(d.changes().get("MEMORY.md")).not.toContain("billing");
  });

  it("promotes feedback two spaces learned under one name — once", () => {
    const d = draftOf(repo(store({
      "spaces/work/small-prs.md": fact("small-prs", "feedback", "Keep PRs small", "Small PRs get reviewed."),
      "spaces/home/small-prs.md": fact("small-prs", "feedback", "Keep PRs small", "Small PRs get reviewed."),
    })));
    expect(d.promote()).toBe(2); // terse + small-prs
    const root = d.changes().get("MEMORY.md")!;
    expect(root.match(/small-prs/g)).toHaveLength(2); // the link and the source of ONE entry
    expect(root).toContain("[[spaces/work/small-prs]]");
    expect(root).not.toContain("[[spaces/home/small-prs]]");
  });

  it("adds nothing the root already links", () => {
    const linked = ROOT.replace("## Index", "- Terse ([[spaces/home/terse]])\n\n## Index");
    const d = draftOf(repo(store({ "MEMORY.md": linked })));
    expect(d.promote()).toBe(0);
    expect(d.changes().size).toBe(0);
  });

  it("does nothing while the root was changed in the last hour", () => {
    const d = draftOf(repo(store(), ["MEMORY.md"]));
    expect(d.promote()).toBe(0);
  });
});

describe("the model's plan, applied to the draft", () => {
  const merge: TidyOp = { op: "merge", into: "spaces/work/billing-owner.md", from: ["spaces/work/billing-lead.md"], description: "Dana owns and runs billing", body: "Dana owns and runs billing; ask her before changing invoices." };

  it("merges duplicates: one file keeps the merged fact, the others go, and so do their index lines", () => {
    const d = draftOf(repo(store()));
    expect(d.apply(merge)).toBeNull();
    const c = d.changes();
    expect(c.get("spaces/work/billing-lead.md")).toBeNull();
    expect(c.get("spaces/work/billing-owner.md")).toBe(
      '---\nname: billing-owner\ndescription: "Dana owns and runs billing"\nmetadata:\n  node_type: memory\n  type: project\n---\n\nDana owns and runs billing; ask her before changing invoices.\n');
    expect(c.get("spaces/work/MEMORY.md")!.split("\n").slice(0, 2)).toEqual([
      "- [Billing owner](billing-owner.md) — Dana owns and runs billing",
      "- [Deploy day](deploy-day.md) — ships on Thursdays, and a great deal more words than any index line needs to carry",
    ]);
  });

  it("deletes a stale fact, its index line and any root line linking it", () => {
    const linked = ROOT.replace("## Index", "- Ships Thursdays ([[spaces/work/deploy-day]])\n\n## Index");
    const d = draftOf(repo(store({ "MEMORY.md": linked, ...olds(5) })));
    expect(d.apply({ op: "delete", path: "spaces/work/deploy-day.md", why: "moved to daily deploys" })).toBeNull();
    const c = d.changes();
    expect(c.get("spaces/work/deploy-day.md")).toBeNull();
    expect(c.get("spaces/work/MEMORY.md")).not.toContain("deploy-day");
    expect(c.get("MEMORY.md")).not.toContain("deploy-day");
  });

  it("rewrites a contradicted fact, header kept, index line following its description", () => {
    const d = draftOf(repo(store()));
    expect(d.apply({ op: "rewrite", path: "spaces/work/deploy-day.md", description: "Ships daily", body: "Billing ships every day now." })).toBeNull();
    expect(d.changes().get("spaces/work/deploy-day.md")).toContain("description: \"Ships daily\"\nmetadata:\n  node_type: memory\n  type: project\n---\n\nBilling ships every day now.\n");
    expect(d.changes().get("spaces/work/MEMORY.md")).toContain("- [Deploy day](deploy-day.md) — Ships daily");
  });

  it("shortens an index line, and keeps a root entry's provenance when the new line drops it", () => {
    const d = draftOf(repo(store()));
    expect(d.apply({ op: "line", file: "spaces/work/MEMORY.md", line: "- [Deploy day](deploy-day.md) — ships on Thursdays, and a great deal more words than any index line needs to carry", to: "- [Deploy day](deploy-day.md) — ships Thursdays" })).toBeNull();
    expect(d.apply({ op: "line", file: "MEMORY.md", line: "- Works in TypeScript [source: realm:session/s0; added: 2026-10-01]", to: "- Writes TypeScript" })).toBeNull();
    expect(d.changes().get("spaces/work/MEMORY.md")).toContain("- [Deploy day](deploy-day.md) — ships Thursdays\n");
    expect(d.changes().get("MEMORY.md")).toContain("- Writes TypeScript [source: realm:session/s0; added: 2026-10-01]\n");
  });

  it("removes a root entry that is no longer true", () => {
    const d = draftOf(repo(store()));
    expect(d.apply({ op: "line", file: "MEMORY.md", line: "- Works in TypeScript [source: realm:session/s0; added: 2026-10-01]", to: null })).toBeNull();
    expect(d.changes().get("MEMORY.md")).not.toContain("TypeScript");
  });

  it.each<[string, TidyOp, RegExp]>([
    ["a line that loses its link", { op: "line", file: "spaces/work/MEMORY.md", line: "- [Billing owner](billing-owner.md) — Dana owns billing", to: "- Dana owns billing" }, /drops a link/],
    ["removing a folder index line rather than deleting the file", { op: "line", file: "spaces/work/MEMORY.md", line: "- [Billing owner](billing-owner.md) — Dana owns billing", to: null }, /delete the file instead/],
    ["unlinking a space's folder from the root", { op: "line", file: "MEMORY.md", line: "- [[spaces/work/MEMORY]]", to: null }, /unlink a space's folder/],
    ["a line that is not there", { op: "line", file: "MEMORY.md", line: "- Never said", to: null }, /no line reads like that/],
    ["a file outside the folders in use", { op: "delete", path: "spaces/other/x.md" }, /not a fact in a folder in use/],
    ["a path out of the repo", { op: "delete", path: "../../etc/passwd" }, /not a fact in a folder in use/],
    ["the root index as a fact", { op: "delete", path: "MEMORY.md" }, /not a fact in a folder in use/],
    ["a merge across spaces", { op: "merge", into: "spaces/work/billing-owner.md", from: ["spaces/home/terse.md"], description: "x", body: "y" }, /different spaces/],
    ["a rewrite holding a secret", { op: "rewrite", path: "spaces/work/deploy-day.md", description: "Deploy key", body: "The key is ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, /secret/],
    // One line shaped like a secret would make the store refuse the whole pass's commit.
    ["a promotion holding a secret", { op: "promote", path: "spaces/work/deploy-day.md", line: "Deploys with ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, /secret/],
  ])("refuses %s", (_what, op, why) => {
    const d = draftOf(repo(store()));
    expect(d.apply(op)).toMatch(why);
    expect(d.changes().size).toBe(0);
  });

  it("never touches a file changed in the last hour — nor one it would have to change with it", () => {
    const d = draftOf(repo(store(), ["spaces/work/billing-lead.md"]));
    expect(d.apply(merge)).toMatch(/last hour/);
    const busyIndex = draftOf(repo(store(), ["spaces/work/MEMORY.md"]));
    expect(busyIndex.apply({ op: "delete", path: "spaces/work/deploy-day.md" })).toMatch(/last hour/);
    expect(busyIndex.changes().size).toBe(0);
  });

  it("counts each root line that goes with a fact against the cap — one the person wrote included", () => {
    // 9 facts and 2 root entries: a fifth of 11 is 2. Deleting deploy-day takes its file AND the line
    // the person wrote about it, which is the whole of this pass's share.
    const linked = ROOT.replace("## Index", "- Thursdays are for billing deploys, per Dana ([[spaces/work/deploy-day]])\n\n## Index");
    const d = draftOf(repo(store({ "MEMORY.md": linked, ...olds(5) })));
    expect(d.cap).toBe(2);
    expect(d.apply({ op: "delete", path: "spaces/work/deploy-day.md" })).toBeNull();
    expect(d.changes().get("MEMORY.md")).not.toContain("per Dana");
    // THE MUTANT counted only the file: it would let one more deletion through.
    expect(d.apply({ op: "delete", path: "spaces/work/old-0.md" })).toMatch(/past its 2 deletions/);
    expect(d.changes().has("spaces/work/old-0.md")).toBe(false);
  });

  it("refuses a deletion whose root lines alone would pass the cap", () => {
    const twice = ROOT.replace("## Index", "- Ships Thursdays ([[spaces/work/deploy-day]])\n- Deploy day, again ([[spaces/work/deploy-day]])\n\n## Index");
    const d = draftOf(repo(store({ "MEMORY.md": twice, ...olds(5) })));
    // 9 facts and 3 root entries: a fifth of 12 is 2, and this one would take three.
    expect(d.cap).toBe(2);
    expect(d.apply({ op: "delete", path: "spaces/work/deploy-day.md" })).toMatch(/past its 2 deletions/);
    expect(d.changes().size).toBe(0);
  });

  it("deletes no more than its share of the store in one pass", () => {
    const d = draftOf(repo(store(olds(9))));
    // 13 facts and 1 root entry: a fifth of 14 is 2.
    expect(d.cap).toBe(2);
    const outcomes = Array.from({ length: 4 }, (_, i) => d.apply({ op: "delete", path: `spaces/work/old-${i}.md` }));
    expect(outcomes.map((o) => o === null)).toEqual([true, true, false, false]);
    expect(outcomes[2]).toMatch(/past its 2 deletions/);
    expect([...d.changes().values()].filter((v) => v === null)).toHaveLength(2);
  });

  it("promotes a fact the model calls the person's, in the model's words, linking the file", () => {
    const d = draftOf(repo(store({ "spaces/work/no-mocks.md": fact("no-mocks", "feedback", "No mocked databases", "Use a real database in tests.") })));
    expect(d.apply({ op: "promote", path: "spaces/work/no-mocks.md", line: "Prefers real databases over mocks in tests" })).toBeNull();
    expect(d.changes().get("MEMORY.md")).toContain(
      "- Prefers real databases over mocks in tests ([[spaces/work/no-mocks]]) [source: spaces/work/no-mocks.md; added: 2026-10-28]\n\n## Index");
    // The file stays in its space: the root links it.
    expect(d.changes().has("spaces/work/no-mocks.md")).toBe(false);
  });

  it("does not promote what the root already links, nor while the root was just changed", () => {
    const d = draftOf(repo(store()));
    d.promote();
    expect(d.apply({ op: "promote", path: "spaces/home/terse.md", line: "Likes short answers" })).toMatch(/already links it/);
    const busy = draftOf(repo(store(), ["MEMORY.md"]));
    expect(busy.apply({ op: "promote", path: "spaces/work/deploy-day.md", line: "Ships Thursdays" })).toMatch(/last hour/);
    expect(busy.changes().size).toBe(0);
  });

  it("acts only on files the model saw whole", () => {
    const d = draftOf(repo(store()));
    d.showOnly(["spaces/work/billing-owner.md"]);
    expect(d.apply({ op: "delete", path: "spaces/work/deploy-day.md" })).toMatch(/did not see whole/);
    expect(d.apply({ op: "promote", path: "spaces/work/deploy-day.md", line: "Ships Thursdays" })).toMatch(/did not see whole/);
  });
});

describe("TidyDraft.drifted — what was written under the pass while it planned", () => {
  /** The files as the store holds them now: the snapshot's, with `now` laid over it. */
  const reader = (dir: string, now: Record<string, string | null> = {}) => (path: string): string | null => {
    if (path in now) return now[path]!;
    try { return readFileSync(join(dir, path), "utf8"); } catch { return null; }
  };
  const merge: TidyOp = { op: "merge", into: "spaces/work/billing-owner.md", from: ["spaces/work/billing-lead.md"], description: "Dana owns and runs billing", body: "Dana owns and runs billing." };

  it("names nothing while every file the pass changes reads as it did", () => {
    const dir = repo(store());
    const d = draftOf(dir);
    d.apply(merge);
    expect(d.drifted(reader(dir))).toEqual([]);
  });

  it("names each file the pass changes that was written since — one rewritten, one already gone", () => {
    const dir = repo(store());
    const d = draftOf(dir);
    d.apply(merge);
    const now = reader(dir, { "spaces/work/MEMORY.md": "- [Billing owner](billing-owner.md) — saved during the call\n", "spaces/work/billing-lead.md": null });
    expect(d.drifted(now).sort()).toEqual(["spaces/work/MEMORY.md", "spaces/work/billing-lead.md"]);
  });

  it("names a file the pass would make that was made since", () => {
    const files = store();
    delete (files as Record<string, string>)["MEMORY.md"];
    const dir = repo(files);
    const d = draftOf(dir);
    expect(d.promote()).toBe(1);
    expect(d.drifted(reader(dir))).toEqual([]);
    expect(d.drifted(reader(dir, { "MEMORY.md": "# Memory\n" }))).toEqual(["MEMORY.md"]);
  });

  it("does not care about a file the pass leaves alone", () => {
    const dir = repo(store());
    const d = draftOf(dir);
    d.apply(merge);
    expect(d.drifted(reader(dir, { "spaces/home/terse.md": "rewritten", "spaces/work/deploy-day.md": null }))).toEqual([]);
  });
});

describe("parseTidyPlan", () => {
  it("reads a plan, and forgives a fence", () => {
    expect(parseTidyPlan('{"operations": []}')).toEqual({ ok: true, operations: [] });
    expect(parseTidyPlan('```json\n{"operations": [{"op": "delete", "path": "spaces/a/b.md"}]}\n```')).toMatchObject({ ok: true, operations: [{ op: "delete" }] });
  });

  it.each([
    ["prose", "I would merge the billing facts."],
    ["prose before a plan", 'Here is the plan:\n{"operations": []}'],
    ["an unknown operation", '{"operations": [{"op": "move", "path": "a"}]}'],
    ["a two-line description", '{"operations": [{"op": "rewrite", "path": "a", "description": "a\\nb", "body": "c"}]}'],
    ["more than twenty operations", JSON.stringify({ operations: Array.from({ length: 21 }, () => ({ op: "delete", path: "a" })) })],
  ])("refuses %s", (_what, raw) => {
    expect(parseTidyPlan(raw).ok).toBe(false);
  });
});

/** A tidier over a repo on disk, with the store's folders for s1 (work) and s2 (home), both recorded. */
function tidier(dir: string, o: { plan?: unknown; reply?: string; inactive?: string[]; recorded?: string[]; settings?: Record<string, unknown>; fail?: boolean } = {}) {
  const folders: Record<string, string> = { s1: "work", s2: "home" };
  const settings = new Map<string, unknown>(Object.entries(o.settings ?? {}));
  const batches: { writes: Map<string, string | null>; message: string; author?: string }[] = [];
  const sink: MemorySink = {
    spaceFolderFor: vi.fn((spaceId: string) => (folders[spaceId] && !o.inactive?.includes(spaceId)
      ? { owner: { scope: "profile" as const, id: "p1" }, repoPath: dir, folder: folders[spaceId]!, dir: join(dir, "spaces", folders[spaceId]!) } : null)),
    // As the store does: a function is asked inside the repo's lock, with the repo's path.
    writeBatch: vi.fn(async (_owner, writes, message, author) => {
      batches.push({ writes: typeof writes === "function" ? writes(dir) : writes, message, author });
      return { changed: true, file: "", line: null, sha: "sha1", diff: "" };
    }),
    saveSpaceMemory: vi.fn(async () => { throw new Error("the tidy pass never saves a single fact"); }),
    edit: vi.fn(async () => { throw new Error("the tidy pass never edits an entry on its own"); }),
  };
  const generate = vi.fn(async (_input: MemoryTidyInput) => {
    if (o.fail) throw new Error("network");
    return o.reply ?? JSON.stringify(o.plan ?? { operations: [] });
  });
  let now = NOW;
  const onTidied = vi.fn();
  const t = new MemoryTidier({
    profileIds: () => ["p1"], spaceIdsOf: () => ["s1", "s2"],
    folderRecorded: (spaceId) => (o.recorded ?? ["s1", "s2"]).includes(spaceId),
    sink, settings: { get: (k) => settings.get(k) ?? null, set: (k, v) => { settings.set(k, v); } },
    generate, now: () => now, today: () => "2026-10-28", onTidied,
  });
  return { t, sink, batches, generate, settings, onTidied, advance: (ms: number) => { now += ms; } };
}

describe("MemoryTidier — one pass", () => {
  const plan = { operations: [
    { op: "merge", into: "spaces/work/billing-owner.md", from: ["spaces/work/billing-lead.md"], description: "Dana owns and runs billing", body: "Dana owns and runs billing." },
    { op: "delete", path: "spaces/work/nope.md" },
  ] };

  it("applies the promotion and the plan as ONE commit, from Realm, and says what it dropped", async () => {
    const x = tidier(repo(store()), { plan });
    const r = await x.t.tidy("p1");
    expect(r).toMatchObject({ ran: true, promoted: 1, applied: 1, sha: "sha1" });
    expect(r.ran && r.dropped.map((d) => d.why)).toEqual(["it names a file that is not a fact in a folder in use"]);
    expect(x.batches).toHaveLength(1);
    expect(x.batches[0]!.message).toBe("Tidy memory");
    expect(x.batches[0]!.author).toBe("Realm");
    expect([...x.batches[0]!.writes.keys()].sort()).toEqual(["MEMORY.md", "spaces/work/MEMORY.md", "spaces/work/billing-lead.md", "spaces/work/billing-owner.md"]);
    expect(x.onTidied).toHaveBeenCalledWith({ scope: "profile", id: "p1" });
    expect(x.settings.get("memory.tidiedAt:p1")).toBe(NOW);
  });

  it("shows the model the indexes as the promotion left them, and the fact files", async () => {
    const x = tidier(repo(store()), { plan });
    await x.t.tidy("p1");
    const input = x.generate.mock.calls[0]![0];
    expect(input.indexes.map((i) => i.path)).toEqual(["MEMORY.md", "spaces/work/MEMORY.md", "spaces/home/MEMORY.md"]);
    expect(input.indexes[0]!.text).toContain("[[spaces/home/terse]]");
    expect(input.files.map((f) => f.path).sort()).toEqual(["spaces/home/terse.md", "spaces/work/billing-lead.md", "spaces/work/billing-owner.md", "spaces/work/deploy-day.md"]);
  });

  it("shows a long file cut, and will not act on it", async () => {
    const long = fact("long", "project", "A long one", "x".repeat(4_000));
    const x = tidier(repo(store({ "spaces/work/long.md": long })), { plan: { operations: [{ op: "delete", path: "spaces/work/long.md" }] } });
    const r = await x.t.tidy("p1");
    const shown = x.generate.mock.calls[0]![0].files.find((f) => f.path === "spaces/work/long.md")!;
    expect(shown.text.length).toBeLessThan(long.length);
    expect(shown.text.endsWith("[cut]")).toBe(true);
    expect(r.ran && r.dropped[0]!.why).toMatch(/did not see whole/);
  });

  it("writes nothing in a dry run — not even the time it ran", async () => {
    const x = tidier(repo(store()), { plan });
    const r = await x.t.tidy("p1", { dryRun: true });
    expect(r.ran && [...r.writes.keys()].sort()).toEqual(["MEMORY.md", "spaces/work/MEMORY.md", "spaces/work/billing-lead.md", "spaces/work/billing-owner.md"]);
    expect(x.sink.writeBatch).not.toHaveBeenCalled();
    expect(x.settings.has("memory.tidiedAt:p1")).toBe(false);
  });

  it("refuses a malformed plan and still commits the promotion alone", async () => {
    const x = tidier(repo(store()), { reply: "Merge the billing files." });
    const r = await x.t.tidy("p1");
    expect(r).toMatchObject({ ran: true, promoted: 1, applied: 0, rejected: "the plan is not JSON" });
    expect([...x.batches[0]!.writes.keys()]).toEqual(["MEMORY.md"]);
  });

  it("commits the promotion alone when the call fails", async () => {
    const x = tidier(repo(store()), { fail: true });
    const r = await x.t.tidy("p1");
    expect(r).toMatchObject({ ran: true, promoted: 1, rejected: "the call failed" });
    expect(x.batches).toHaveLength(1);
  });

  it("makes no commit when there is nothing to do", async () => {
    const x = tidier(repo(store({ "MEMORY.md": ROOT.replace("## Index", "- Terse ([[spaces/home/terse]])\n\n## Index") })));
    expect(await x.t.tidy("p1")).toMatchObject({ ran: true, promoted: 0, applied: 0, sha: null });
    expect(x.sink.writeBatch).not.toHaveBeenCalled();
  });
});

describe("MemoryTidier — what it never tidies", () => {
  it("skips a profile that turned learning off", async () => {
    const x = tidier(repo(store()), { settings: { [memoryLearningKey("p1")]: false } });
    expect(await x.t.tidy("p1")).toEqual({ ran: false, why: "off" });
    expect(x.generate).not.toHaveBeenCalled();
  });

  it("skips a profile none of whose spaces has memory in use", async () => {
    const x = tidier(repo(store()), { inactive: ["s1", "s2"] });
    expect(await x.t.tidy("p1")).toEqual({ ran: false, why: "no memory in use" });
  });

  it("leaves the folder of a space whose memory is off — and asks no space without a recorded folder for one", async () => {
    const x = tidier(repo(store()), { inactive: ["s1"], recorded: ["s1", "s2"] });
    await x.t.tidy("p1");
    expect(x.generate.mock.calls[0]![0].files.map((f) => f.path)).toEqual(["spaces/home/terse.md"]);
    const y = tidier(repo(store()), { recorded: ["s2"] });
    await y.t.tidy("p1");
    expect(y.sink.spaceFolderFor).toHaveBeenCalledTimes(1);
    expect(y.sink.spaceFolderFor).toHaveBeenCalledWith("s2");
  });
});

describe("MemoryTidier — when it runs", () => {
  it("only starts the clock the first time it sees a profile", async () => {
    const x = tidier(repo(store()));
    x.t.check("p1");
    expect(x.settings.get("memory.tidiedAt:p1")).toBe(NOW);
    expect(x.generate).not.toHaveBeenCalled();
  });

  it("tidies once a week has passed, and not before", async () => {
    const x = tidier(repo(store()), { settings: { "memory.tidiedAt:p1": NOW } });
    x.advance(TIDY_EVERY_MS - 1);
    x.t.check("p1");
    await vi.waitFor(() => expect(x.generate).not.toHaveBeenCalled());
    x.advance(1);
    x.t.check("p1");
    await vi.waitFor(() => expect(x.generate).toHaveBeenCalledTimes(1));
  });

  it("tidies a day after the last pass when the indexes have grown too long", async () => {
    const long = `${ROOT}${"- a line of a long index\n".repeat(Math.ceil(TIDY_INDEX_MAX / 24))}`;
    const x = tidier(repo(store({ "MEMORY.md": long })), { settings: { "memory.tidiedAt:p1": NOW } });
    expect(x.t.indexChars("p1")).toBeGreaterThan(TIDY_INDEX_MAX);
    x.advance(TIDY_SOONEST_MS - 1);
    x.t.check("p1");
    expect(x.generate).not.toHaveBeenCalled();
    x.advance(1);
    x.t.check("p1");
    await vi.waitFor(() => expect(x.generate).toHaveBeenCalledTimes(1));
  });

  it("waits the week when the indexes are short", () => {
    const x = tidier(repo(store()), { settings: { "memory.tidiedAt:p1": NOW } });
    x.advance(TIDY_SOONEST_MS * 3);
    x.t.check("p1");
    expect(x.generate).not.toHaveBeenCalled();
  });

  it("does not try again within the week after a pass that failed", async () => {
    const x = tidier(repo(store()), { fail: true, settings: { "memory.tidiedAt:p1": NOW - TIDY_EVERY_MS } });
    x.t.check("p1");
    await vi.waitFor(() => expect(x.generate).toHaveBeenCalledTimes(1));
    x.advance(HOUR);
    x.t.check("p1");
    expect(x.generate).toHaveBeenCalledTimes(1);
  });

  it("never runs for a profile that switched learning off", () => {
    const x = tidier(repo(store()), { settings: { [memoryLearningKey("p1")]: false, "memory.tidiedAt:p1": NOW - 2 * TIDY_EVERY_MS } });
    x.t.check("p1");
    expect(x.generate).not.toHaveBeenCalled();
  });
});
