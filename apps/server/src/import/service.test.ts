import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMPORT_MEMORY_MARKER_OPEN, IMPORTED_SPACE_NAME } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { dbPath } from "../paths";
import { EnvironmentsStore } from "../store/environments";
import { ItemsStore } from "../store/items";
import { ProfilesStore } from "../store/profiles";
import { ProjectsStore } from "../store/projects";
import { SessionEventsStore, SessionsStore } from "../store/sessions";
import { SettingsStore } from "../store/settings";
import { SpacesStore } from "../store/spaces";
import { MemoryService } from "../memory/service";
import { ImportService, type ImportSelection } from "./service";
import type { ImportRoots } from "./sources";
import type { RpcServer } from "../rpc/server";

/**
 * The whole suite runs against a fixture tree and a scratch Realm home. Nothing here reads
 * `~/.claude`, `~/.codex` or `~/.cursor`, and `roots` is overridden as a UNIT — a test that inherited
 * even one real root would be reading the developer's own history.
 */

const write = (path: string, text: string): void => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n");

/** A Cursor session store, built the way Cursor builds one: hex meta row, protobuf root blob whose
 *  field 1 is the ordered chain, and one content-addressed blob per message. */
function writeCursorStore(dir: string, name: string, messages: unknown[], cwd: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, cwd }));
  const db = new DatabaseSync(join(dir, "store.db"));
  db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  const ids: Buffer[] = [];
  const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
  messages.forEach((m, i) => {
    const id = Buffer.alloc(32, i + 1);
    ids.push(id);
    insert.run(id.toString("hex"), Buffer.from(JSON.stringify(m), "utf8"));
  });
  const root = Buffer.concat(ids.flatMap((id) => [Buffer.from([0x0a, 32]), id]));
  const rootId = Buffer.alloc(32, 0xee).toString("hex");
  insert.run(rootId, root);
  db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)")
    .run(Buffer.from(JSON.stringify({ agentId: name, latestRootBlobId: rootId, name, createdAt: 1_700_000_000_000 }), "utf8").toString("hex"));
  db.close();
}

type Harness = {
  home: string; roots: ImportRoots; imports: ImportService;
  /** A second service over the same home and database — what a server restart looks like, for the
   *  facts that must survive one (the imported-source set). */
  freshService(): ImportService;
  sessions: SessionsStore; events: SessionEventsStore; items: ItemsStore;
  spaces: SpacesStore; profiles: ProfilesStore; memory: MemoryService;
  workProfileId: string; realmSpaceId: string; realmProjectRoot: string;
};

function harness(): Harness {
  const home = mkdtempSync(join(tmpdir(), "realm-import-home-"));
  const fixtures = mkdtempSync(join(tmpdir(), "realm-import-src-"));
  const roots: ImportRoots = {
    claude: join(fixtures, "claude"), codex: join(fixtures, "codex"), cursor: join(fixtures, "cursor"),
    extraSkillDirs: [join(fixtures, "agents", "skills")],
  };

  const db = openDatabase(dbPath(home));
  const profiles = new ProfilesStore(db);
  const spaces = new SpacesStore(db, home);
  const settings = new SettingsStore(db);
  const environments = new EnvironmentsStore(db);
  const projects = new ProjectsStore(db);
  const work = profiles.create({ name: "Work", icon: "briefcase", color: "#111111" });
  profiles.create({ name: "School", icon: "cap", color: "#222222" });
  const realm = spaces.create({ profileId: work.id, name: "Realm", icon: "folder" });
  // A project root the matcher can find: a real directory, since the walk resolves paths.
  const realmProjectRoot = join(fixtures, "checkouts", "realm");
  mkdirSync(realmProjectRoot, { recursive: true });
  projects.create({ spaceId: realm.id, name: "realm", rootPath: realmProjectRoot, defaultBranch: "main" });

  const memory = new MemoryService({ home, settings, environments, claudeDir: join(roots.claude),
    scopes: { profileIdOf: (id) => spaces.get(id)?.profileId ?? null } });
  const sessions = new SessionsStore(db);
  const events = new SessionEventsStore(db);
  const items = new ItemsStore(db);
  const rpc = { broadcast: () => {} } as unknown as RpcServer;
  const deps = { home, db, rpc, spaces, profiles, projects, environments, sessions, events, items, settings, memory, roots };
  const imports = new ImportService(deps);
  return { home, roots, imports, freshService: () => new ImportService(deps), sessions, events, items, spaces, profiles, memory,
    workProfileId: work.id, realmSpaceId: realm.id, realmProjectRoot };
}

const claudeTranscript = (id: string, cwd: string, turns: number): string => jsonl([
  { type: "ai-title", aiTitle: `Session ${id}`, sessionId: id },
  ...Array.from({ length: turns }, (_, i) => [
    { type: "user", sessionId: id, cwd, isSidechain: false, timestamp: new Date(1_780_000_000_000 + i * 1000).toISOString(), message: { role: "user", content: [{ type: "text", text: `ask ${i}` }] } },
    { type: "assistant", sessionId: id, cwd, isSidechain: false, timestamp: new Date(1_780_000_000_000 + i * 1000 + 500).toISOString(), message: { id: `m${i}`, model: "claude-opus-5", content: [{ type: "text", text: `answer ${i}` }] } },
  ]).flat(),
]);

describe("ImportService.scan", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it("finds transcripts from all three sources and matches them to spaces", () => {
    write(join(h.roots.claude, "projects", "-a", "c1.jsonl"), claudeTranscript("c1", h.realmProjectRoot, 2));
    write(join(h.roots.codex, "sessions", "2027", "01", "01", "rollout-x.jsonl"), jsonl([
      { timestamp: "2027-01-01T00:00:00.000Z", type: "session_meta", payload: { session_id: "x1", cwd: "/Users/me/elsewhere", originator: "Codex Desktop" } },
      { timestamp: "2027-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "hi" } },
    ]));
    writeCursorStore(join(h.roots.cursor, "acp-sessions", "u1"), "Cursor chat",
      [{ role: "user", content: [{ type: "text", text: "hello" }] }], h.realmProjectRoot);

    const scan = h.imports.scan();
    expect(scan.sessions).toHaveLength(3);
    expect(scan.sources.map((s) => s.source)).toEqual(["claude", "codex", "cursor"]);

    const claude = scan.sessions.find((s) => s.source === "claude")!;
    expect(claude).toMatchObject({ agentKind: "claude", providerSessionId: "c1", messages: 4, cwdExists: true, imported: false });
    expect(claude.match).toMatchObject({ spaceId: h.realmSpaceId, reason: "project" });

    const cursor = scan.sessions.find((s) => s.source === "cursor")!;
    expect(cursor.agentKind).toBe("acp:cursor");
    expect(cursor.match.spaceId).toBe(h.realmSpaceId);

    // No space fits the Codex one, so it names a profile instead — and creates nothing.
    const codex = scan.sessions.find((s) => s.source === "codex")!;
    expect(codex.match).toMatchObject({ spaceId: null, fallbackProfileId: h.workProfileId, reason: "fallback" });
    expect(h.spaces.list(h.workProfileId).map((s) => s.name)).toEqual(["Realm"]);
  });

  it("writes nothing at all — a scan is a read", () => {
    write(join(h.roots.claude, "projects", "-a", "c1.jsonl"), claudeTranscript("c1", h.realmProjectRoot, 1));
    write(join(h.roots.claude, "skills", "helper", "SKILL.md"), "---\nname: helper\ndescription: helps\n---\nbody");
    const before = { spaces: h.spaces.listAll().length, sessions: h.sessions.listAll().length };
    h.imports.scan();
    expect(h.spaces.listAll()).toHaveLength(before.spaces);
    expect(h.sessions.listAll()).toHaveLength(before.sessions);
    expect(existsSync(join(h.home, "skills", "helper"))).toBe(false);
  });

  it("flags scratch, Realm-originated and already-imported rows instead of hiding them", () => {
    write(join(h.roots.claude, "projects", "-tmp", "c1.jsonl"), claudeTranscript("c1", join(tmpdir(), "realm-live-x"), 1));
    write(join(h.roots.codex, "sessions", "r.jsonl"), jsonl([
      { timestamp: "2027-01-01T00:00:00.000Z", type: "session_meta", payload: { session_id: "x1", cwd: "/Users/me/x", originator: "realm" } },
      { timestamp: "2027-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "hi" } },
    ]));
    const scan = h.imports.scan();
    expect(scan.sessions.find((s) => s.source === "claude")!.scratch).toBe(true);
    expect(scan.sessions.find((s) => s.source === "codex")!.fromRealm).toBe(true);
    // Both are still LISTED: the client defaults them off and can say what it hid.
    expect(scan.sessions).toHaveLength(2);
  });

  it("offers only the FULLEST copy of a thread the CLI rewrote on every resume", () => {
    // Codex writes a new rollout file each time a thread is resumed, replaying the whole
    // conversation so far under the same session_id. On the developer's machine 158 files were one
    // Stora thread. Importing them all would make 158 near-identical sessions; importing whichever
    // one was scanned first loses turns — a 13-turn copy there had been written BEFORE a 9-turn one,
    // so "newest" is the wrong winner and "most turns" is the right one.
    const replay = (file: string, turns: number, day: string) =>
      write(join(h.roots.codex, "sessions", file), jsonl([
        { timestamp: `${day}T00:00:00.000Z`, type: "session_meta", payload: { session_id: "thread-1", cwd: "/Users/me/stora" } },
        ...Array.from({ length: turns }, (_, i) => ({ timestamp: `${day}T00:00:0${i}.000Z`, type: "event_msg", payload: { type: "user_message", message: `turn ${i}` } })),
      ]));
    replay("a.jsonl", 13, "2027-01-01"); // written first, but the most complete
    replay("b.jsonl", 9, "2027-01-02");  // written later, and shorter
    replay("c.jsonl", 4, "2027-01-03");

    const scan = h.imports.scan();
    const kept = scan.sessions.filter((s) => !s.duplicate);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.messages).toBe(13);
    expect(scan.sessions.filter((s) => s.duplicate)).toHaveLength(2);
    // And the source report counts CONVERSATIONS, naming the gap rather than leaving it to be found.
    const codex = scan.sources.find((s) => s.source === "codex")!;
    expect(codex.sessions).toBe(1);
    expect(codex.note).toContain("3 files hold 1 conversations");
  });

  it("picks the same winner on every scan, so a preview cannot re-target itself before apply", () => {
    for (const [file, day] of [["a.jsonl", "2027-01-01"], ["b.jsonl", "2027-01-02"]] as const) {
      write(join(h.roots.codex, "sessions", file), jsonl([
        { timestamp: `${day}T00:00:00.000Z`, type: "session_meta", payload: { session_id: "thread-1", cwd: "/Users/me/x" } },
        { timestamp: `${day}T00:00:01.000Z`, type: "event_msg", payload: { type: "user_message", message: "same length" } },
      ]));
    }
    const first = h.imports.scan().sessions.filter((s) => !s.duplicate).map((s) => s.key);
    const second = h.imports.scan().sessions.filter((s) => !s.duplicate).map((s) => s.key);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
  });

  it("does not confuse two genuinely different conversations", () => {
    write(join(h.roots.claude, "projects", "-a", "c1.jsonl"), claudeTranscript("c1", h.realmProjectRoot, 2));
    write(join(h.roots.claude, "projects", "-a", "c2.jsonl"), claudeTranscript("c2", h.realmProjectRoot, 1));
    expect(h.imports.scan().sessions.filter((s) => s.duplicate)).toHaveLength(0);
  });

  it("counts transcripts it could not read rather than pretending they were not there", () => {
    write(join(h.roots.claude, "projects", "-a", "broken.jsonl"), "{ not json\n{ also not");
    const scan = h.imports.scan();
    expect(scan.sessions).toHaveLength(0);
    expect(scan.sources.find((s) => s.source === "claude")!.unreadable).toBe(1);
  });

  it("offers one row per skill id, listing every agent folder it was found in", () => {
    write(join(h.roots.claude, "skills", "shared", "SKILL.md"), "---\nname: shared\ndescription: from claude\n---\n");
    write(join(h.roots.extraSkillDirs[0]!, "shared", "SKILL.md"), "---\nname: shared\ndescription: from agents\n---\n");
    write(join(h.roots.codex, "skills", "solo", "SKILL.md"), "---\nname: solo\ndescription: only codex\n---\n");
    // Malformed frontmatter is not offered: importing a broken skill just moves the problem.
    write(join(h.roots.claude, "skills", "broken", "SKILL.md"), "no frontmatter here");
    const skills = h.imports.scan().skills;
    expect(skills.map((s) => s.key)).toEqual(["shared", "solo"]);
    expect(skills[0]!.origins).toEqual(["claude", "agents"]);
  });
});

describe("ImportService.apply — sessions", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  const applySessions = (sel: ImportSelection["sessions"]) => h.imports.apply({ sessions: sel, memories: [], skills: [] });

  it("creates a session with its transcript, its item, and its real timestamps", () => {
    write(join(h.roots.claude, "projects", "-a", "c1.jsonl"), claudeTranscript("c1", h.realmProjectRoot, 2));
    const key = h.imports.scan().sessions[0]!.key;
    const result = applySessions([{ key, spaceId: h.realmSpaceId, profileId: null }]);

    expect(result.sessions[0]).toMatchObject({ state: "imported" });
    const session = h.sessions.listAll()[0]!;
    expect(session).toMatchObject({ spaceId: h.realmSpaceId, agentKind: "claude", status: "ended", title: "Session c1" });
    expect(session.dispatchedBy).toEqual({ kind: "import", sessionId: null });
    const events = h.events.listAfter(session.id, 0, 100);
    expect(events).toHaveLength(4);
    expect(events[0]!.event.ts).toBe(1_780_000_000_000);
    expect(session.lastEventSeq).toBe(events[3]!.seq);
    expect(h.items.list(h.realmSpaceId).some((i) => i.refId === session.id)).toBe(true);
  });

  it("carries the provider id when the cwd still exists, so the session can be resumed", () => {
    write(join(h.roots.claude, "projects", "-a", "c1.jsonl"), claudeTranscript("c1", h.realmProjectRoot, 1));
    const key = h.imports.scan().sessions[0]!.key;
    const r = applySessions([{ key, spaceId: h.realmSpaceId, profileId: null }]);
    expect(h.sessions.listAll()[0]!.providerSessionId).toBe("c1");
    expect(r.sessions[0]!.detail).toContain("resumable");
    // And it runs where it ran: a `checkout` environment at the recorded directory.
    expect(h.sessions.listAll()[0]!.cwd).toBe(h.realmProjectRoot);
  });

  it("imports as history with no provider link when the recorded cwd is gone", () => {
    write(join(h.roots.claude, "projects", "-a", "c1.jsonl"), claudeTranscript("c1", "/Users/me/deleted-long-ago", 1));
    const key = h.imports.scan().sessions[0]!.key;
    const r = applySessions([{ key, spaceId: h.realmSpaceId, profileId: null }]);
    // Resuming into a missing directory fails inside the CLI with nothing Realm could say about it,
    // so the link is left off rather than advertised and then broken.
    expect(h.sessions.listAll()[0]!.providerSessionId).toBeNull();
    expect(r.sessions[0]!.detail).toContain("archive");
    expect(h.sessions.listAll()[0]!.cwd).toBe(h.spaces.get(h.realmSpaceId)!.folderPath);
  });

  it("never imports the same conversation twice, within one apply or across two", () => {
    write(join(h.roots.claude, "projects", "-a", "c1.jsonl"), claudeTranscript("c1", h.realmProjectRoot, 1));
    const key = h.imports.scan().sessions[0]!.key;
    const first = applySessions([{ key, spaceId: h.realmSpaceId, profileId: null }, { key, spaceId: h.realmSpaceId, profileId: null }]);
    expect(first.sessions.map((s) => s.state)).toEqual(["imported", "skipped"]);
    expect(h.sessions.listAll()).toHaveLength(1);

    expect(h.imports.scan().sessions[0]!.imported).toBe(true);
    const second = applySessions([{ key, spaceId: h.realmSpaceId, profileId: null }]);
    expect(second.sessions[0]).toMatchObject({ state: "skipped", detail: "already imported" });
    expect(h.sessions.listAll()).toHaveLength(1);
  });

  it("never re-imports an ARCHIVE, which carries no provider id to dedup on", () => {
    // The bug this exists for: a transcript whose cwd is gone imports with providerSessionId null
    // (it must not advertise a resume it cannot perform), so the provider-id dedup has nothing to
    // match on and it re-imported on every single run — 31 duplicate sessions on the second pass
    // against real data.
    write(join(h.roots.claude, "projects", "-a", "c1.jsonl"), claudeTranscript("c1", "/Users/me/deleted-long-ago", 1));
    const key = h.imports.scan().sessions[0]!.key;
    applySessions([{ key, spaceId: h.realmSpaceId, profileId: null }]);
    expect(h.sessions.listAll()[0]!.providerSessionId).toBeNull();

    expect(h.imports.scan().sessions[0]!.imported).toBe(true);
    const again = applySessions([{ key, spaceId: h.realmSpaceId, profileId: null }]);
    expect(again.sessions[0]).toMatchObject({ state: "skipped", detail: "already imported" });
    expect(h.sessions.listAll()).toHaveLength(1);
  });

  it("remembers imported sources across a fresh service, not just within one process", () => {
    write(join(h.roots.claude, "projects", "-a", "c1.jsonl"), claudeTranscript("c1", "/Users/me/gone", 1));
    const key = h.imports.scan().sessions[0]!.key;
    applySessions([{ key, spaceId: h.realmSpaceId, profileId: null }]);
    // A new service over the same home — what a server restart looks like.
    expect(h.freshService().scan().sessions[0]!.imported).toBe(true);
  });

  it("titles a session from the first turn a PERSON wrote, not the harness preamble before it", () => {
    // Conductor opens with a `<system_instruction>` envelope on the user channel; 30 imported
    // sessions were called `<system_instruction>` in the sidebar before this.
    write(join(h.roots.codex, "sessions", "r.jsonl"), jsonl([
      { timestamp: "2027-01-01T00:00:00.000Z", type: "session_meta", payload: { session_id: "x1", cwd: "/Users/me/x" } },
      { timestamp: "2027-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "<system_instruction>\nYou are working inside Conductor." } },
      { timestamp: "2027-01-01T00:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "Fix the failing build" } },
    ]));
    const candidate = h.imports.scan().sessions[0]!;
    expect(candidate.title).toBe("Fix the failing build");
    // The preamble is still IN the transcript — it really was part of what the agent was given.
    applySessions([{ key: candidate.key, spaceId: h.realmSpaceId, profileId: null }]);
    const session = h.sessions.listAll()[0]!;
    expect(h.events.listAfter(session.id, 0, 100).filter((e) => e.event.type === "user_message")).toHaveLength(2);
  });

  it("names a session generically when every turn is an envelope, rather than titling it with XML", () => {
    // A `/login` transcript is nothing but `<local-command-caveat>` and `<command-name>` wrappers.
    // There is no human sentence in it, and a row of XML in the sidebar is not a better answer than
    // saying so.
    write(join(h.roots.codex, "sessions", "r.jsonl"), jsonl([
      { timestamp: "2027-01-01T00:00:00.000Z", type: "session_meta", payload: { session_id: "x1", cwd: "/Users/me/x" } },
      { timestamp: "2027-01-01T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "<local-command-caveat>Caveat: the messages below…</local-command-caveat>" } },
      { timestamp: "2027-01-01T00:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "<command-name>/login</command-name>" } },
    ]));
    const candidate = h.imports.scan().sessions[0]!;
    applySessions([{ key: candidate.key, spaceId: h.realmSpaceId, profileId: null }]);
    expect(h.sessions.listAll()[0]!.title).toBe("Imported session");
  });

  it("creates one catch-all space per profile and reuses it", () => {
    write(join(h.roots.claude, "projects", "-a", "c1.jsonl"), claudeTranscript("c1", "/Users/me/nowhere-a", 1));
    write(join(h.roots.claude, "projects", "-b", "c2.jsonl"), claudeTranscript("c2", "/Users/me/nowhere-b", 1));
    const keys = h.imports.scan().sessions.map((s) => s.key);
    const r = applySessions(keys.map((key) => ({ key, spaceId: null, profileId: h.workProfileId })));

    expect(r.spacesCreated).toHaveLength(1);
    expect(r.spacesCreated[0]).toMatchObject({ name: IMPORTED_SPACE_NAME, profileId: h.workProfileId });
    const imported = h.spaces.list(h.workProfileId).find((s) => s.name === IMPORTED_SPACE_NAME)!;
    expect(h.sessions.list(imported.id)).toHaveLength(2);

    // A later run finds the existing one rather than making "Imported 2".
    write(join(h.roots.claude, "projects", "-c", "c3.jsonl"), claudeTranscript("c3", "/Users/me/nowhere-c", 1));
    const third = h.imports.scan().sessions.find((s) => s.providerSessionId === "c3")!;
    const again = applySessions([{ key: third.key, spaceId: null, profileId: h.workProfileId }]);
    expect(again.spacesCreated).toHaveLength(0);
    expect(h.spaces.list(h.workProfileId).filter((s) => s.name === IMPORTED_SPACE_NAME)).toHaveLength(1);
  });

  it("honours the client's target verbatim — the matcher does not get to overrule it", () => {
    write(join(h.roots.claude, "projects", "-a", "c1.jsonl"), claudeTranscript("c1", h.realmProjectRoot, 1));
    const candidate = h.imports.scan().sessions[0]!;
    expect(candidate.match.spaceId).toBe(h.realmSpaceId);
    const other = h.spaces.create({ profileId: h.workProfileId, name: "Elsewhere", icon: "folder" });
    applySessions([{ key: candidate.key, spaceId: other.id, profileId: null }]);
    expect(h.sessions.listAll()[0]!.spaceId).toBe(other.id);
  });

  it("refuses a key no scan produced — apply is not a read-any-file call", () => {
    const r = applySessions([{ key: "/etc/passwd", spaceId: h.realmSpaceId, profileId: null }]);
    expect(r.sessions[0]).toMatchObject({ state: "skipped", detail: "no longer on disk" });
    expect(h.sessions.listAll()).toHaveLength(0);
  });

  it("reports a candidate with no target instead of guessing one", () => {
    write(join(h.roots.claude, "projects", "-a", "c1.jsonl"), claudeTranscript("c1", h.realmProjectRoot, 1));
    const key = h.imports.scan().sessions[0]!.key;
    const r = applySessions([{ key, spaceId: null, profileId: null }]);
    expect(r.sessions[0]!.state).toBe("failed");
    expect(h.sessions.listAll()).toHaveLength(0);
  });

  it("one bad row does not cost the others their import", () => {
    write(join(h.roots.claude, "projects", "-a", "c1.jsonl"), claudeTranscript("c1", h.realmProjectRoot, 1));
    const key = h.imports.scan().sessions[0]!.key;
    const r = applySessions([
      { key: "/nope", spaceId: h.realmSpaceId, profileId: null },
      { key, spaceId: h.realmSpaceId, profileId: null },
    ]);
    expect(r.sessions.map((s) => s.state)).toEqual(["skipped", "imported"]);
    expect(h.sessions.listAll()).toHaveLength(1);
  });
});

describe("ImportService.apply — memory", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  const writeMemory = (slug: string, files: Record<string, string>, index: string) => {
    for (const [name, body] of Object.entries(files)) write(join(h.roots.claude, "projects", slug, "memory", name), body);
    write(join(h.roots.claude, "projects", slug, "memory", "MEMORY.md"), index);
  };

  it("copies the fact files under Realm's home and puts the index in the space doc", () => {
    writeMemory("-proj", { "a-fact.md": "---\nname: a-fact\n---\nthe fact body" },
      "# Memory Index\n\n- [A fact](a-fact.md) — the hook");
    const candidate = h.imports.scan().memories[0]!;
    expect(candidate.files).toBe(1);

    const r = h.imports.apply({ sessions: [], memories: [{ key: candidate.key, spaceId: h.realmSpaceId, profileId: null }], skills: [] });
    expect(r.memories[0]!.state).toBe("imported");

    const copied = join(h.home, "memory", "imported", h.realmSpaceId, "proj", "a-fact.md");
    expect(readFileSync(copied, "utf8")).toContain("the fact body");

    const doc = h.memory.readDoc(h.realmSpaceId);
    expect(doc).toContain(IMPORT_MEMORY_MARKER_OPEN);
    // The index's relative link is rewritten to the COPY's absolute path — a link into the CLI's own
    // folder would point at the one place this import does not want anyone reaching.
    expect(doc).toContain(`](${copied})`);
    expect(doc).not.toContain("](a-fact.md)");
  });

  it("does not overwrite the user's own writing, and re-import replaces rather than duplicates", () => {
    writeMemory("-proj", { "a-fact.md": "body" }, "- [A fact](a-fact.md)");
    h.memory.set(h.realmSpaceId, "My own standing instructions.");
    const key = h.imports.scan().memories[0]!.key;

    h.imports.apply({ sessions: [], memories: [{ key, spaceId: h.realmSpaceId, profileId: null }], skills: [] });
    expect(h.memory.readDoc(h.realmSpaceId)).toContain("My own standing instructions.");

    h.imports.apply({ sessions: [], memories: [{ key, spaceId: h.realmSpaceId, profileId: null }], skills: [] });
    const doc = h.memory.readDoc(h.realmSpaceId);
    expect(doc.split(IMPORT_MEMORY_MARKER_OPEN)).toHaveLength(2);
    expect(doc).toContain("My own standing instructions.");
  });

  it("keeps two projects imported into one space apart, and lists both", () => {
    writeMemory("-one", { "x.md": "x body" }, "- [X](x.md)");
    writeMemory("-two", { "y.md": "y body" }, "- [Y](y.md)");
    const keys = h.imports.scan().memories.map((m) => m.key);
    h.imports.apply({ sessions: [], memories: keys.map((key) => ({ key, spaceId: h.realmSpaceId, profileId: null })), skills: [] });
    const doc = h.memory.readDoc(h.realmSpaceId);
    expect(doc).toContain("### one");
    expect(doc).toContain("### two");
    expect(existsSync(join(h.home, "memory", "imported", h.realmSpaceId, "one", "x.md"))).toBe(true);
    expect(existsSync(join(h.home, "memory", "imported", h.realmSpaceId, "two", "y.md"))).toBe(true);
  });

  it("imports a memory folder far larger than the doc cap without truncating it", () => {
    // The case that decided the design: 100k is the whole doc budget, and this folder is bigger.
    const big = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}.md`, "z".repeat(5_000)]));
    writeMemory("-huge", big, Object.keys(big).map((f) => `- [${f}](${f})`).join("\n"));
    const key = h.imports.scan().memories[0]!.key;
    h.imports.apply({ sessions: [], memories: [{ key, spaceId: h.realmSpaceId, profileId: null }], skills: [] });
    for (const f of Object.keys(big)) {
      expect(readFileSync(join(h.home, "memory", "imported", h.realmSpaceId, "huge", f), "utf8")).toHaveLength(5_000);
    }
    expect(h.memory.readDoc(h.realmSpaceId).length).toBeLessThan(100_000);
  });
});

describe("ImportService.apply — skills", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it("copies a skill into the library and leaves the source alone", () => {
    const source = join(h.roots.claude, "skills", "helper", "SKILL.md");
    write(source, "---\nname: helper\ndescription: helps with things\n---\nbody");
    write(join(h.roots.claude, "skills", "helper", "reference.md"), "extra file");

    const r = h.imports.apply({ sessions: [], memories: [], skills: ["helper"] });
    expect(r.skills[0]!.state).toBe("imported");
    expect(readFileSync(join(h.home, "skills", "helper", "SKILL.md"), "utf8")).toContain("helps with things");
    // The whole directory, not just the one file.
    expect(existsSync(join(h.home, "skills", "helper", "reference.md"))).toBe(true);
    expect(existsSync(source)).toBe(true);
  });

  it("never overwrites a library entry the user may have edited", () => {
    write(join(h.roots.claude, "skills", "helper", "SKILL.md"), "---\nname: helper\ndescription: the CLI's copy\n---\n");
    write(join(h.home, "skills", "helper", "SKILL.md"), "---\nname: helper\ndescription: MY edited copy\n---\n");
    const r = h.imports.apply({ sessions: [], memories: [], skills: ["helper"] });
    expect(r.skills[0]).toMatchObject({ state: "skipped", detail: "already in the library" });
    expect(readFileSync(join(h.home, "skills", "helper", "SKILL.md"), "utf8")).toContain("MY edited copy");
  });

  it("refuses a skill id that is not a plain directory name", () => {
    const r = h.imports.apply({ sessions: [], memories: [], skills: ["../../etc"] });
    expect(r.skills[0]!.state).toBe("failed");
  });
});
