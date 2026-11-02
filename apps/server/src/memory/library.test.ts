import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { MEMORY_EXTERNAL_UNCONFIRMED, type Environment } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { MemoryLibrary, readFrontmatter, type LibrarySpace } from "./library";
import { MemoryRepoService } from "./repo";
import { AGENTS_FILE_MARKER, MemoryService } from "./service";

const PROFILE = "01ARZ3NDEKTSV4RRFFQ69G5FP1";
const WORK = "01ARZ3NDEKTSV4RRFFQ69G5FP2";
const REALM = "01ARZ3NDEKTSV4RRFFQ69G5FS1";
const STORA = "01ARZ3NDEKTSV4RRFFQ69G5FS2";
const PAYROLL = "01ARZ3NDEKTSV4RRFFQ69G5FS3";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });
const put = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const fact = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n---\n\n${body}\n`;

/**
 * A Mac in a folder: Realm's home with a profile repo, and a stand-in for the user's home holding each
 * agent's own files — `.claude` (with a project's memory), `.codex`, `.cursor/rules`, `.gemini` — and
 * the folders two spaces of the profile work in. A third space, of another profile, has files of its
 * own that the first profile's library must never list.
 */
async function harness() {
  const root = tempDir("realm-memlib-");
  const home = join(root, "realm");
  const user = join(root, "user");
  const claudeDir = join(user, ".claude");
  const codexHome = join(user, ".codex");
  const folders: Record<string, string> = { [REALM]: join(user, "code", "realm"), [STORA]: join(user, "code", "stora"), [PAYROLL]: join(user, "code", "payroll") };
  for (const f of Object.values(folders)) mkdirSync(f, { recursive: true });
  const spaces: LibrarySpace[] = [
    { id: REALM, profileId: PROFILE, name: "Realm", folders: [folders[REALM]!] },
    { id: STORA, profileId: PROFILE, name: "Stora", folders: [folders[STORA]!] },
    { id: PAYROLL, profileId: WORK, name: "Payroll", folders: [folders[PAYROLL]!] },
  ];
  const settings = new SettingsStore(openDatabase(join(root, "realm.db")));
  const repos = new MemoryRepoService({
    home, settings,
    scopes: {
      profileIdOf: (id) => spaces.find((sp) => sp.id === id)?.profileId ?? null,
      spaceIdsOf: (p) => spaces.filter((sp) => sp.profileId === p).map((sp) => sp.id),
      spaceNameOf: (id) => spaces.find((sp) => sp.id === id)?.name ?? null,
    },
    committerName: async () => "Tester",
  });
  const { path: repo } = await repos.create({ scope: "profile", id: PROFILE });
  const env = (spaceId: string): Environment => ({ id: `env-${spaceId}`, spaceId, path: folders[spaceId]!, branch: null, kind: "primary", portBlockStart: null, createdAt: 0, updatedAt: 0 });
  const memory = new MemoryService({ home, settings, environments: { ensurePrimary: env }, claudeDir, scopes: { profileIdOf: (id) => spaces.find((sp) => sp.id === id)?.profileId ?? null }, repos });
  const trashed: string[] = [];
  const changed: string[][] = [];
  const library = new MemoryLibrary({
    home, userHome: user, claudeDir, codexHome, settings,
    profiles: () => [{ id: PROFILE, name: "Carlton" }, { id: WORK, name: "Work" }],
    spaces: () => spaces,
    repos, docs: memory,
    trash: async (p) => { trashed.push(p); },
    onChanged: (ids) => { changed.push(ids); },
  });

  // Realm's own: two topic files at the root, a fact in Realm's folder, and a space document.
  put(join(repo, "creators.md"), fact("Creator campaign", "Who runs the spring creator campaign", "The briefs live in the shared Drive; see [[contacts]] and [the team](team.md)."));
  put(join(repo, "contacts.md"), "# Contacts\n\n- Maya runs partnerships\n");
  const realmDir = repos.spaceFolderFor(REALM)!.dir;
  put(join(realmDir, "uses-pnpm.md"), fact("uses-pnpm", "The repo uses pnpm", "pnpm, never npm."));
  put(join(realmDir, "MEMORY.md"), "- [uses-pnpm](uses-pnpm.md) — the repo uses pnpm\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "seed");
  memory.set(STORA, "Stora ships on Fridays.\n");

  // Each agent's own.
  put(join(claudeDir, "CLAUDE.md"), "# House rules\n\nPrefer small PRs.\n");
  put(join(claudeDir, "projects", "-Users-me-code-stora", "memory", "deploy.md"), fact("deploy", "How Stora deploys", "Tag main."));
  put(join(claudeDir, "projects", "-Users-me-code-stora", "memory", "notes.txt"), "not memory\n");
  put(join(claudeDir, "settings.json"), "{}\n");
  put(join(codexHome, "AGENTS.md"), "Codex everywhere.\n");
  put(join(user, ".cursor", "rules", "style.mdc"), "---\ndescription: House style\nglobs: \"*.ts\"\n---\n\nTabs.\n");
  put(join(user, ".gemini", "GEMINI.md"), "Gemini everywhere.\n");
  put(join(folders[REALM]!, "CLAUDE.md"), "# Realm\n\nThe Realm checkout.\n");
  put(join(folders[STORA]!, "AGENTS.md"), `${AGENTS_FILE_MARKER} managed -->\n\nStora ships on Fridays.\n`);
  put(join(folders[STORA]!, ".cursor", "rules", "api.mdc"), "Use the API client.\n");
  put(join(folders[PAYROLL]!, "CLAUDE.md"), "Payroll is another profile's.\n");
  return { root, home, user, repo, repos, memory, library, folders, claudeDir, trashed, changed, realmDir };
}

const idOf = (entries: { id: string; rel: string; sourceId: string }[], sourceId: string, rel: string): string =>
  entries.find((e) => e.sourceId === sourceId && e.rel === rel)!.id;

describe("readFrontmatter", () => {
  it("reads Claude's nested type and YAML's quoted scalars, and leaves the body after the block", () => {
    const r = readFrontmatter("---\nname: \"a: b\"\ndescription: 'it''s'\nmetadata:\n  type: user\nglobs:\n  - \"*.ts\"\n---\n\nBody.\n");
    expect(r.fields).toEqual([{ key: "name", value: "a: b" }, { key: "description", value: "it's" }, { key: "metadata.type", value: "user" }]);
    expect(r.body).toBe("Body.\n");
    expect(readFrontmatter("No block.\n")).toEqual({ fields: [], body: "No block.\n" });
  });
});

describe("MemoryLibrary — discovery", () => {
  it("lists every source of the profile that exists, Realm's first, and none of another profile's", async () => {
    const h = await harness();
    const sources = h.library.sources(PROFILE);
    const summary = sources.map((s) => [s.group, s.label, s.count, s.external]);
    expect(summary).toEqual([
      ["realm", "Memory repo", 5, false],
      ["realm", "Memory documents", 1, false],
      ["claude", "User memory", 1, true],
      ["claude", "Project memory", 1, true],
      ["claude", "Realm", 1, true],
      ["codex", "User instructions", 1, true],
      ["codex", "Stora", 1, true],
      ["cursor", "User rules", 1, true],
      ["cursor", "Stora", 1, true],
      ["gemini", "User memory", 1, true],
    ]);
    // THE MUTANT: list every space's folder — Payroll is another profile's, and its CLAUDE.md is not this library's.
    expect(sources.some((s) => s.path.includes("payroll"))).toBe(false);
    expect(sources.find((s) => s.label === "Memory repo")).toMatchObject({ creatable: true, pointed: true });
    expect(sources.find((s) => s.label === "Project memory")).toMatchObject({ pointed: false });
  });

  it("draws no source that does not exist", async () => {
    const h = await harness();
    const library = new MemoryLibrary({
      home: h.home, userHome: join(h.root, "nobody"), claudeDir: join(h.root, "nobody", ".claude"), codexHome: null,
      settings: new SettingsStore(openDatabase(join(h.root, "other.db"))),
      profiles: () => [{ id: PROFILE, name: "Carlton" }], spaces: () => [], repos: h.repos, docs: h.memory, trash: async () => {},
    });
    expect(library.sources(PROFILE).map((s) => s.label)).toEqual(["Memory repo"]);
  });

  it("lists each file with its title, description, type and folder, newest first", async () => {
    const h = await harness();
    const entries = h.library.list(PROFILE);
    const pnpm = entries.find((e) => e.rel === "spaces/realm/uses-pnpm.md")!;
    expect(pnpm).toMatchObject({ title: "uses-pnpm", description: "The repo uses pnpm", type: "project", folder: "Realm" });
    expect(entries.find((e) => e.rel === "contacts.md")).toMatchObject({ title: "Contacts", description: "Maya runs partnerships", type: null, folder: null });
    expect(entries.find((e) => e.rel === `${STORA}.md`)).toMatchObject({ title: "Stora", description: "Stora ships on Fridays.", folder: "Space document" });
    expect(entries.find((e) => e.sourceId === "claude-projects")).toMatchObject({ rel: "-Users-me-code-stora/memory/deploy.md", title: "deploy" });
    // Only Markdown: the project's `notes.txt` and Claude's `settings.json` are not memory.
    expect(entries.some((e) => e.rel.endsWith(".txt") || e.rel.endsWith(".json"))).toBe(false);
    const times = entries.map((e) => e.updatedAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(h.library.list(PROFILE, { sourceId: "codex-user" }).map((e) => e.title)).toEqual(["AGENTS"]);
  });
});

describe("MemoryLibrary — reading", () => {
  it("parts the frontmatter from the body and resolves both kinds of link", async () => {
    const h = await harness();
    const entries = h.library.list(PROFILE);
    const f = h.library.read(idOf(entries, `realm-repo-profile-${PROFILE}`, "creators.md"), PROFILE);
    expect(f.frontmatter).toEqual([
      { key: "name", value: "Creator campaign" }, { key: "description", value: "Who runs the spring creator campaign" }, { key: "metadata.type", value: "project" },
    ]);
    expect(f.body.startsWith("The briefs live")).toBe(true);
    expect(f.links).toEqual([
      { target: "contacts", id: idOf(entries, `realm-repo-profile-${PROFILE}`, "contacts.md") },
      { target: "team.md", id: null },
    ]);
    expect(f).toMatchObject({ external: false, writable: true, deletable: true });
  });

  it("says who reads each file, from the model a session's sources come from", async () => {
    const h = await harness();
    const entries = h.library.list(PROFILE);
    const readBy = (sourceId: string, rel: string) => h.library.read(idOf(entries, sourceId, rel), PROFILE).readBy;
    expect(readBy(`realm-repo-profile-${PROFILE}`, "MEMORY.md")).toEqual([{ who: "Every agent", where: "every space", how: "at the start of every session" }]);
    expect(readBy(`realm-repo-profile-${PROFILE}`, "spaces/realm/uses-pnpm.md")).toEqual([
      { who: "Claude", where: "Realm", how: "as its own memory" }, { who: "Other agents", where: "Realm", how: "through Realm's memory tools" },
    ]);
    expect(readBy(`realm-docs-${PROFILE}`, `${STORA}.md`)).toEqual([{ who: "Every agent", where: "Stora", how: "at the start of every session" }]);
    expect(readBy("claude-user", "CLAUDE.md")).toEqual([{ who: "Claude", where: "every space", how: null }]);
    // THE MUTANT: say every space for a folder's file — only the space working in that folder loads it.
    const folder = h.library.sources(PROFILE).find((s) => s.group === "claude" && s.label === "Realm")!;
    expect(readBy(folder.id, "CLAUDE.md")).toEqual([{ who: "Claude", where: "Realm", how: null }]);
    expect(readBy("codex-user", "AGENTS.md")).toEqual([{ who: "Codex", where: "every space", how: null }]);
    expect(readBy("claude-projects", "-Users-me-code-stora/memory/deploy.md")).toEqual([{ who: "Claude", where: "outside Realm", how: "in that project's sessions" }]);
  });

  it("keeps an AGENTS.md Realm writes read-only, and says where to edit it", async () => {
    const h = await harness();
    const entries = h.library.list(PROFILE);
    const src = h.library.sources(PROFILE).find((s) => s.group === "codex" && s.label === "Stora")!;
    const f = h.library.read(idOf(entries, src.id, "AGENTS.md"));
    expect(f).toMatchObject({ writable: false, deletable: false });
    expect(f.note).toMatch(/memory document/);
    await expect(h.library.write(f.id, "mine now", true)).rejects.toMatchObject({ code: "MEMORY_READ_ONLY" });
  });
});

describe("MemoryLibrary — the allow-list", () => {
  it("reads nothing a source does not list", async () => {
    const h = await harness();
    // THE MUTANT: join the path onto the source's root and read whatever is there.
    for (const id of ["claude-user:settings.json", "claude-user:../realm/realm.db", "claude-user:/etc/hosts", `realm-repo-profile-${PROFILE}:.git/config`, "nowhere:CLAUDE.md", "no-colon"]) {
      expect(() => h.library.read(id), id).toThrow(expect.objectContaining({ code: "MEMORY_FILE_NOT_FOUND" }));
    }
  });

  it("refuses a link that leads out of its source, and keeps one that stays in", async () => {
    const h = await harness();
    const secret = join(h.root, "secret.md");
    writeFileSync(secret, "# Secret\n");
    symlinkSync(secret, join(h.repo, "escape.md"));
    symlinkSync(join(h.repo, "contacts.md"), join(h.repo, "contacts-again.md"));
    rmClaudeAndLink(h.folders[REALM]!, secret);
    const entries = h.library.list(PROFILE);
    expect(entries.some((e) => e.rel === "escape.md")).toBe(false);
    expect(entries.some((e) => e.rel === "contacts-again.md")).toBe(true);
    expect(h.library.sources(PROFILE).some((s) => s.group === "claude" && s.label === "Realm")).toBe(false);
    expect(() => h.library.read(`realm-repo-profile-${PROFILE}:escape.md`)).toThrow(expect.objectContaining({ code: "MEMORY_FILE_NOT_FOUND" }));
  });
});

function rmClaudeAndLink(folder: string, to: string): void {
  execFileSync("rm", [join(folder, "CLAUDE.md")]);
  symlinkSync(to, join(folder, "CLAUDE.md"));
}

describe("MemoryLibrary — Realm's repos", () => {
  it("writes a file as one commit, and keeps its folder's index line in step with a new name", async () => {
    const h = await harness();
    const entries = h.library.list(PROFILE);
    const id = idOf(entries, `realm-repo-profile-${PROFILE}`, "spaces/realm/uses-pnpm.md");
    const before = Number(git(h.repo, "rev-list", "--count", "HEAD").trim());
    await h.library.write(id, fact("Package manager", "The repo uses pnpm 10", "pnpm 10, never npm."));
    expect(Number(git(h.repo, "rev-list", "--count", "HEAD").trim())).toBe(before + 1);
    expect(git(h.repo, "log", "-1", "--format=%s").trim()).toBe("Update spaces/realm/uses-pnpm.md");
    expect(readFileSync(join(h.realmDir, "MEMORY.md"), "utf8")).toBe("- [Package manager](uses-pnpm.md) — The repo uses pnpm 10\n");
    expect(git(h.repo, "status", "--porcelain")).toBe("");
    expect(h.changed.at(-1)).toEqual([REALM, STORA]);
  });

  it("makes a memory at the root, linked from MEMORY.md, as one commit — and refuses a second of one name", async () => {
    const h = await harness();
    const e = await h.library.create({ sourceId: `realm-repo-profile-${PROFILE}`, name: "Spring campaign logins", description: "Where the logins are kept", type: "reference", body: "In 1Password, vault Creators." });
    expect(e).toMatchObject({ rel: "spring-campaign-logins.md", title: "Spring campaign logins", type: "reference" });
    expect(readFileSync(join(h.repo, "spring-campaign-logins.md"), "utf8")).toBe(
      "---\nname: Spring campaign logins\ndescription: Where the logins are kept\nmetadata:\n  type: reference\n---\n\nIn 1Password, vault Creators.\n");
    expect(readFileSync(join(h.repo, "MEMORY.md"), "utf8")).toContain("- [[spring-campaign-logins]]");
    expect(git(h.repo, "log", "-1", "--format=%s").trim()).toBe("Remember Spring campaign logins");
    expect(git(h.repo, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual(["MEMORY.md", "spring-campaign-logins.md"]);
    await expect(h.library.create({ sourceId: `realm-repo-profile-${PROFILE}`, name: "Spring campaign logins", description: "again", type: "reference", body: "" }))
      .rejects.toMatchObject({ code: "MEMORY_EXISTS" });
  });

  it("makes a memory in a space's folder with its index line, and refuses a source that is not Realm's", async () => {
    const h = await harness();
    const e = await h.library.create({ sourceId: `realm-repo-profile-${PROFILE}`, spaceId: STORA, name: "Ships Fridays", description: "Stora ships on Fridays", type: "project", body: "Freeze Thursday." });
    expect(e).toMatchObject({ rel: "spaces/stora/ships-fridays.md", folder: "Stora" });
    expect(readFileSync(join(h.repo, "spaces", "stora", "MEMORY.md"), "utf8")).toBe("- [Ships Fridays](ships-fridays.md) — Stora ships on Fridays\n");
    expect(readFileSync(join(h.repo, "MEMORY.md"), "utf8")).toContain("- [[spaces/stora/MEMORY]]");
    await expect(h.library.create({ sourceId: "claude-user", name: "x", description: "y", type: "user", body: "" })).rejects.toMatchObject({ code: "MEMORY_READ_ONLY" });
  });

  it("deletes a file with its index lines as one commit, and never MEMORY.md", async () => {
    const h = await harness();
    const entries = h.library.list(PROFILE);
    const r = await h.library.delete(idOf(entries, `realm-repo-profile-${PROFILE}`, "spaces/realm/uses-pnpm.md"));
    expect(r).toEqual({ trashed: false });
    expect(existsSync(join(h.realmDir, "uses-pnpm.md"))).toBe(false);
    expect(readFileSync(join(h.realmDir, "MEMORY.md"), "utf8")).toBe("");
    expect(git(h.repo, "log", "-1", "--format=%s").trim()).toBe("Forget spaces/realm/uses-pnpm.md");
    expect(git(h.repo, "status", "--porcelain")).toBe("");
    await h.library.create({ sourceId: `realm-repo-profile-${PROFILE}`, name: "Gone soon", description: "d", type: "user", body: "" });
    await h.library.delete(`realm-repo-profile-${PROFILE}:gone-soon.md`);
    // THE MUTANT: leave the root's index line — MEMORY.md would link a file that is gone.
    expect(readFileSync(join(h.repo, "MEMORY.md"), "utf8")).not.toContain("[[gone-soon]]");
    expect(h.trashed).toEqual([]);
    await expect(h.library.delete(`realm-repo-profile-${PROFILE}:MEMORY.md`)).rejects.toMatchObject({ code: "MEMORY_INDEX_WHOLE" });
  });

  it("writes a memory document through the document's own save", async () => {
    const h = await harness();
    const entries = h.library.list(PROFILE);
    await h.library.write(idOf(entries, `realm-docs-${PROFILE}`, `${STORA}.md`), "Stora ships on Thursdays.\n");
    expect(h.memory.readDoc(STORA)).toBe("Stora ships on Thursdays.\n");
    expect(h.changed.at(-1)).toEqual([STORA]);
    await expect(h.library.delete(idOf(entries, `realm-docs-${PROFILE}`, `${STORA}.md`))).rejects.toMatchObject({ code: "MEMORY_READ_ONLY" });
  });
});

describe("MemoryLibrary — files outside Realm", () => {
  it("writes or deletes one only with the person's yes, and deletes to the Trash", async () => {
    const h = await harness();
    const id = "claude-user:CLAUDE.md";
    // THE MUTANT: write any file the library lists — Claude's own file changed with nobody asked.
    await expect(h.library.write(id, "changed\n")).rejects.toMatchObject({ code: MEMORY_EXTERNAL_UNCONFIRMED });
    expect(readFileSync(join(h.claudeDir, "CLAUDE.md"), "utf8")).toBe("# House rules\n\nPrefer small PRs.\n");
    await h.library.write(id, "# House rules\n\nPrefer small PRs. Squash.\n", true);
    expect(readFileSync(join(h.claudeDir, "CLAUDE.md"), "utf8")).toBe("# House rules\n\nPrefer small PRs. Squash.\n");
    await expect(h.library.delete("gemini-user:GEMINI.md")).rejects.toMatchObject({ code: MEMORY_EXTERNAL_UNCONFIRMED });
    expect(h.trashed).toEqual([]);
    expect(await h.library.delete("gemini-user:GEMINI.md", true)).toEqual({ trashed: true });
    expect(h.trashed).toEqual([join(h.user, ".gemini", "GEMINI.md")]);
  });
});

describe("MemoryLibrary — search", () => {
  it("finds a file by what its body says, best first, with the line that matched", async () => {
    const h = await harness();
    const hits = h.library.list(PROFILE, { query: "shared drive briefs" });
    expect(hits[0]).toMatchObject({ rel: "creators.md", match: expect.stringContaining("shared Drive") });
    // A word still being typed finds names before the ranking can.
    expect(h.library.list(PROFILE, { query: "cam" }).map((e) => e.rel)).toContain("creators.md");
    expect(h.library.list(PROFILE, { query: "nothing like this anywhere" })).toEqual([]);
  });
});
