import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionEvent, type SearchSnippet } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { SettingsStore } from "../store/settings";
import { ItemsStore } from "../store/items";
import { SessionsStore, SessionEventsStore } from "../store/sessions";
import { EnvironmentsStore } from "../store/environments";
import { SkillsService } from "../skills/service";
import { MemoryService } from "../memory/service";
import { NotFoundError } from "../store/rows";
import { BACKFILL_CHUNK, SEARCH_BACKFILL_KEY, SearchService, ftsExpression, liveMatches, liveSnippet, parseFtsSnippet, queryTokens } from "./service";

function harness() {
  const home = mkdtempSync(join(tmpdir(), "realm-search-"));
  const db = openDatabase(join(home, "realm.db"));
  const profiles = new ProfilesStore(db);
  const spaces = new SpacesStore(db, home);
  const settings = new SettingsStore(db);
  const environments = new EnvironmentsStore(db);
  const scopes = { profileIdOf: (sid: string) => spaces.get(sid)?.profileId ?? null };
  const skills = new SkillsService({ home, settings, bundledDir: null, scopes });
  const memory = new MemoryService({ home, settings, environments, claudeDir: join(home, "no-claude"), scopes });
  const search = new SearchService({ db, settings, profiles, spaces, skills, memory });
  const sessions = new SessionsStore(db);
  const events = new SessionEventsStore(db);
  const items = new ItemsStore(db);

  const work = profiles.create({ name: "Work", icon: "u", color: "#000" });
  const school = profiles.create({ name: "School", icon: "u", color: "#000" });
  const alpha = spaces.create({ profileId: work.id, name: "Alpha", icon: "f" });
  const beta = spaces.create({ profileId: school.id, name: "Beta", icon: "f" });
  const envA = environments.ensurePrimary(alpha.id);
  const envB = environments.ensurePrimary(beta.id);

  const newSession = (spaceId: string, environmentId: string, title = "A session") =>
    sessions.create({ spaceId, projectId: null, agentKind: "fake", model: null, effort: null, permissionMode: "default", environmentId, title });

  return { home, db, profiles, spaces, settings, environments, skills, memory, search, sessions, events, items, work, school, alpha, beta, envA, envB, newSession };
}

const flat = (s: SearchSnippet) => s.map((p) => p.text).join("");
const marked = (s: SearchSnippet) => s.filter((p) => p.match).map((p) => p.text).join("|");

describe("query building", () => {
  it("tokenizes on non-word runs, lowercased, unicode included", () => {
    expect(queryTokens("Fix the  LOGIN—flow café")).toEqual(["fix", "the", "login", "flow", "café"]);
  });
  it("quotes every token and prefixes the last — FTS syntax can never leak in", () => {
    expect(ftsExpression("fix AND (login:")).toBe('"fix" "and" "login"*');
    expect(ftsExpression("  —  ")).toBeNull();
  });
  it("parses marked snippets into alternating segments", () => {
    expect(parseFtsSnippet("say hello there")).toEqual([
      { text: "say ", match: false }, { text: "hello", match: true }, { text: " there", match: false },
    ]);
  });
  it("liveSnippet windows around the first hit and marks every in-window occurrence", () => {
    const text = `${"x".repeat(200)} the magic word, and magic again`;
    const snip = liveSnippet(text, ["magic"]);
    expect(flat(snip)).toContain("magic word");
    expect(flat(snip).startsWith("…")).toBe(true);
    expect(marked(snip)).toBe("magic|magic");
    expect(liveMatches(text, ["magic", "word"])).toBe(true);
    expect(liveMatches(text, ["magic", "absent"])).toBe(false);
  });
});

describe("indexed sources — each write path pins its own FTS row", () => {
  it("user_message text is searchable the moment it is appended", () => {
    const h = harness();
    const s = h.newSession(h.alpha.id, h.envA.id);
    h.events.append(s.id, sessionEvent("user_message", { text: "please refactor the flux capacitor", attachments: [] }));
    const r = h.search.query(h.work.id, "flux capacitor");
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]).toMatchObject({ sessionId: s.id, spaceId: h.alpha.id });
    expect(marked(r.sessions[0]!.snippet)).toContain("flux");
  });

  it("assistant_text is searchable; deltas, thinking and tool events are not indexed", () => {
    const h = harness();
    const s = h.newSession(h.alpha.id, h.envA.id);
    h.events.append(s.id, sessionEvent("assistant_text", { messageId: "m1", text: "I rebuilt the zeppelin module" }));
    h.events.append(s.id, sessionEvent("thinking", { messageId: "m2", text: "secret contemplation about quokkas" }));
    h.events.append(s.id, sessionEvent("tool_result", { toolUseId: "t1", content: "grep found wombats everywhere", isError: false }));
    expect(h.search.query(h.work.id, "zeppelin").sessions).toHaveLength(1);
    expect(h.search.query(h.work.id, "quokkas").sessions).toHaveLength(0);
    expect(h.search.query(h.work.id, "wombats").sessions).toHaveLength(0);
  });

  it("one session with many hits is one result row, carrying the best event's seq", () => {
    const h = harness();
    const s = h.newSession(h.alpha.id, h.envA.id);
    for (let i = 0; i < 5; i++) h.events.append(s.id, sessionEvent("user_message", { text: `pelican number ${i}`, attachments: [] }));
    const r = h.search.query(h.work.id, "pelican");
    expect(r.sessions).toHaveLength(1);
    expect(typeof r.sessions[0]!.seq).toBe("number");
  });

  it("item titles: indexed on create, moved on rename, scrubbed on delete", () => {
    const h = harness();
    const it1 = h.items.create({ spaceId: h.alpha.id, kind: "terminal", title: "ostrich dashboard", refId: h.envA.id });
    expect(h.search.query(h.work.id, "ostrich").items.map((i) => i.itemId)).toEqual([it1.id]);
    h.items.update({ id: it1.id, title: "flamingo dashboard" });
    expect(h.search.query(h.work.id, "ostrich").items).toHaveLength(0);
    expect(h.search.query(h.work.id, "flamingo").items.map((i) => i.itemId)).toEqual([it1.id]);
    h.items.delete(it1.id);
    expect(h.search.query(h.work.id, "flamingo").items).toHaveLength(0);
  });

  it("deleting a session scrubs its transcript from the index", () => {
    const h = harness();
    const s = h.newSession(h.alpha.id, h.envA.id);
    h.events.append(s.id, sessionEvent("user_message", { text: "ephemeral axolotl question", attachments: [] }));
    expect(h.search.query(h.work.id, "axolotl").sessions).toHaveLength(1);
    h.sessions.delete(s.id);
    expect(h.search.query(h.work.id, "axolotl").sessions).toHaveLength(0);
  });

  it("a session-owned terminal item never surfaces (the palette's own hidden-item rule)", () => {
    const h = harness();
    const s = h.newSession(h.alpha.id, h.envA.id);
    const hidden = h.items.create({ spaceId: h.alpha.id, kind: "terminal", title: "hidden panel narwhal", refId: s.id });
    h.sessions.setTerminalItem(s.id, hidden.id);
    expect(h.search.query(h.work.id, "narwhal").items).toHaveLength(0);
  });
});

describe("live sources — files are read at query time, never cached", () => {
  it("finds a skill by name+description, including one dropped into the folder moments ago", () => {
    const h = harness();
    const dir = join(h.home, "skills", "tide-charts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: Tide charts\ndescription: Predicts coastal tide tables\n---\nbody");
    const r = h.search.query(h.work.id, "coastal tide");
    expect(r.skills.map((s) => s.id)).toEqual(["tide-charts"]);
    expect(marked(r.skills[0]!.snippet)).toContain("tide");
  });

  it("finds a space memory doc set through the service AND a direct file edit — the reason this source is live", () => {
    const h = harness();
    h.memory.set(h.alpha.id, "Always deploy with the tortoise script");
    expect(h.search.query(h.work.id, "tortoise").memory).toMatchObject([{ scope: "space", spaceId: h.alpha.id }]);
    // The panel shows the doc's path; a user editing it in a text editor must be searchable too.
    writeFileSync(h.memory.docPath(h.alpha.id), "Now we prefer the hedgehog script");
    expect(h.search.query(h.work.id, "tortoise").memory).toHaveLength(0);
    expect(h.search.query(h.work.id, "hedgehog").memory).toHaveLength(1);
  });

  it("finds the profile memory doc, attributed to the profile", () => {
    const h = harness();
    h.memory.setProfile(h.work.id, "Company style: iguana casing everywhere");
    const r = h.search.query(h.work.id, "iguana");
    expect(r.memory).toMatchObject([{ scope: "profile", profileId: h.work.id, spaceId: null }]);
    expect(r.memory[0]!.title).toContain("Work");
  });
});

describe("profile scoping — the named mutant: a Work search must not surface School anything", () => {
  it("transcripts, items, skills and memory are all fenced to the queried profile", () => {
    const h = harness();
    const sa = h.newSession(h.alpha.id, h.envA.id);
    const sb = h.newSession(h.beta.id, h.envB.id);
    h.events.append(sa.id, sessionEvent("user_message", { text: "work secret: giraffe payroll", attachments: [] }));
    h.events.append(sb.id, sessionEvent("user_message", { text: "school secret: giraffe homework", attachments: [] }));
    h.items.create({ spaceId: h.alpha.id, kind: "browser", title: "giraffe docs (work)", refId: sa.id });
    h.items.create({ spaceId: h.beta.id, kind: "browser", title: "giraffe notes (school)", refId: sb.id });
    h.memory.set(h.alpha.id, "work giraffe memory");
    h.memory.set(h.beta.id, "school giraffe memory");

    const workR = h.search.query(h.work.id, "giraffe");
    expect(workR.sessions.map((x) => x.sessionId)).toEqual([sa.id]);
    expect(workR.items.every((x) => x.spaceId === h.alpha.id)).toBe(true);
    expect(workR.memory).toMatchObject([{ spaceId: h.alpha.id }]);
    const schoolR = h.search.query(h.school.id, "giraffe");
    expect(schoolR.sessions.map((x) => x.sessionId)).toEqual([sb.id]);
    expect(schoolR.items.every((x) => x.spaceId === h.beta.id)).toBe(true);
  });

  it("a space moved to another profile answers for its NEW profile — nothing profile-shaped is baked into the index", () => {
    const h = harness();
    const s = h.newSession(h.alpha.id, h.envA.id);
    h.events.append(s.id, sessionEvent("user_message", { text: "migratory albatross", attachments: [] }));
    expect(h.search.query(h.work.id, "albatross").sessions).toHaveLength(1);
    h.spaces.update({ id: h.alpha.id, profileId: h.school.id });
    expect(h.search.query(h.work.id, "albatross").sessions).toHaveLength(0);
    expect(h.search.query(h.school.id, "albatross").sessions).toHaveLength(1);
  });

  it("refuses an unknown profile rather than answering an empty page", () => {
    const h = harness();
    expect(() => h.search.query("01ARZ3NDEKTSV4RRFFQ69G5FAV", "x")).toThrow(NotFoundError);
  });
});

describe("query hardening and quiet states", () => {
  it("hostile FTS syntax is content, never syntax", () => {
    const h = harness();
    const s = h.newSession(h.alpha.id, h.envA.id);
    h.events.append(s.id, sessionEvent("user_message", { text: 'the "quoted" AND cormorant NEAR stuff', attachments: [] }));
    for (const q of ['"quoted" AND cormorant', "cormorant NEAR", 'x OR ""(', "-cormorant", "cormorant*)"]) {
      expect(() => h.search.query(h.work.id, q)).not.toThrow();
    }
    expect(h.search.query(h.work.id, '"quoted" AND cormorant').sessions).toHaveLength(1);
  });
  it("a query with no word characters returns the empty groups", () => {
    const h = harness();
    expect(h.search.query(h.work.id, "—…!!")).toEqual({ sessions: [], items: [], skills: [], memory: [] });
  });
});

describe("backfill — chunked, resumable, never double-indexing", () => {
  /** Raw event inserts bypass the store's write-time indexing, simulating a pre-v15 history. */
  function rawEvents(h: ReturnType<typeof harness>, sessionId: string, n: number, word: string) {
    const ins = h.db.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (?, ?, 'user_message', ?)");
    for (let i = 0; i < n; i++) ins.run(sessionId, i, JSON.stringify({ text: `${word} ${i}`, attachments: [] }));
  }
  const maxSeq = (h: ReturnType<typeof harness>) => (h.db.prepare("SELECT MAX(seq) AS m FROM session_events").get() as { m: number }).m;
  const indexedCount = (h: ReturnType<typeof harness>) =>
    (h.db.prepare("SELECT COUNT(*) AS c FROM search_index WHERE kind = 'session'").get() as { c: number }).c;

  it("indexes a multi-chunk history to completion and closes the cursor", async () => {
    const h = harness();
    const s = h.newSession(h.alpha.id, h.envA.id);
    rawEvents(h, s.id, BACKFILL_CHUNK + 50, "cassowary");
    h.settings.set(SEARCH_BACKFILL_KEY, { done: 0, target: maxSeq(h) });
    const logs: string[] = [];
    await h.search.runBackfill((l) => logs.push(l));
    expect(indexedCount(h)).toBe(BACKFILL_CHUNK + 50);
    expect(h.search.query(h.work.id, "cassowary").sessions).toHaveLength(1);
    const cursor = h.settings.get(SEARCH_BACKFILL_KEY) as { done: number; target: number };
    expect(cursor.done).toBe(cursor.target);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("resumes from the persisted cursor: rows at or before `done` are never re-scanned", async () => {
    const h = harness();
    const s = h.newSession(h.alpha.id, h.envA.id);
    rawEvents(h, s.id, 10, "kookaburra");
    const target = maxSeq(h);
    // Simulate a crash after the first 4 were indexed: cursor persisted, rows present.
    const first = h.db.prepare("SELECT seq, payload_json FROM session_events ORDER BY seq LIMIT 4").all() as { seq: number; payload_json: string }[];
    const ins = h.db.prepare("INSERT INTO search_index (text, kind, ref, seq) VALUES (?, 'session', ?, ?)");
    for (const r of first) ins.run((JSON.parse(r.payload_json) as { text: string }).text, s.id, r.seq);
    h.settings.set(SEARCH_BACKFILL_KEY, { done: first.at(-1)!.seq, target });
    await h.search.runBackfill(() => {});
    expect(indexedCount(h)).toBe(10); // 4 pre-existing + 6 resumed, no duplicates
  });

  it("events past the frozen target are write-time indexed exactly once, even with a backfill pending", async () => {
    const h = harness();
    const s = h.newSession(h.alpha.id, h.envA.id);
    rawEvents(h, s.id, 3, "old-history");
    h.settings.set(SEARCH_BACKFILL_KEY, { done: 0, target: maxSeq(h) });
    // A new event lands through the store while the backfill has not run yet.
    h.events.append(s.id, sessionEvent("user_message", { text: "fresh capybara message", attachments: [] }));
    await h.search.runBackfill(() => {});
    const rows = h.db.prepare("SELECT COUNT(*) AS c FROM search_index WHERE kind = 'session' AND text LIKE '%capybara%'").get() as { c: number };
    expect(rows.c).toBe(1);
    expect(indexedCount(h)).toBe(4);
  });

  it("stop() halts before the next chunk (shutdown must not race db.close)", async () => {
    const h = harness();
    const s = h.newSession(h.alpha.id, h.envA.id);
    rawEvents(h, s.id, 5, "stopped");
    h.settings.set(SEARCH_BACKFILL_KEY, { done: 0, target: maxSeq(h) });
    h.search.stop();
    await h.search.runBackfill(() => {});
    expect(indexedCount(h)).toBe(0);
  });
});
