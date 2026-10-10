import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { ACT_PACING, actKindFor, parseRecord, type ActKind, type ReviewAction } from "@realm/contracts";
import { migrations } from "../db/migrations";
import { TeamStore } from "./store";
import { TeamService } from "./service";
import { ActStore } from "./acts/store";
import { ActService } from "./acts/service";
import { RecordTypeStore } from "./record-types/store";
import { RecordTypeService } from "./record-types/service";

/**
 * Generic deliverables' migration (v52 on the dynamic-Teams line), against ONE hand-written v50 home —
 * not one replayed from `migrations`, because a replayed fixture agrees with any mutation of the list
 * it was built from (the plan, section 2.6). Found by its own text, never by its number: at merge it
 * follows record types (v51) and comes before risk classes (v53).
 *
 * What it must leave: every row of every table byte for byte on its v50 columns; every legacy item's
 * action exactly what `actKindFor` always made of it; and every review's checks exactly what v50 said.
 */
const V52_AT = migrations.findIndex((m) => m.includes("ALTER TABLE team_review_items ADD COLUMN action_json"));

/** The v50 shape of every table a team touches, as the migrations left them, hand-written. */
const V50 = `
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE team_roles (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, brief TEXT NOT NULL, realmite_json TEXT NOT NULL, template TEXT,
  agent_kind TEXT NOT NULL, model TEXT, effort TEXT, permission_mode TEXT NOT NULL DEFAULT 'default',
  skills_json TEXT NOT NULL DEFAULT '[]', wake_on_review INTEGER NOT NULL DEFAULT 1,
  week_budget_usd REAL, run_cap_usd REAL NOT NULL DEFAULT 3, run_cap_ms INTEGER NOT NULL DEFAULT 1200000,
  max_concurrent INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  handoffs_json TEXT NOT NULL DEFAULT '[]', wake_on_mention INTEGER NOT NULL DEFAULT 1);
CREATE TABLE team_reviews (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  role_id TEXT, run_id TEXT, session_id TEXT, record_path TEXT,
  kind TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, note TEXT,
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, decided_at INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE team_review_items (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES team_reviews(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1, ord INTEGER NOT NULL, files_json TEXT NOT NULL, body TEXT, target_json TEXT,
  content_hash TEXT NOT NULL, approved_hash TEXT, act_state TEXT NOT NULL DEFAULT 'none');
CREATE TABLE team_activity (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL, actor TEXT NOT NULL, run_id TEXT, session_id TEXT, verb TEXT NOT NULL, object TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE vault_grants (
  secret_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, hosts_json TEXT NOT NULL DEFAULT '[]', purpose TEXT,
  created_at INTEGER NOT NULL, PRIMARY KEY (secret_id, role_id));
CREATE TABLE team_handoffs (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  from_role_id TEXT, from_session_id TEXT, to_role_id TEXT NOT NULL, record_path TEXT, note TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]', run_id TEXT, session_id TEXT, outcome TEXT, cost_usd REAL,
  created_at INTEGER NOT NULL, settled_at INTEGER);
CREATE TABLE lab_devices (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, udid TEXT, name TEXT NOT NULL,
  space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL, accounts_json TEXT NOT NULL DEFAULT '[]',
  last_seen_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE team_act_tickets (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT NOT NULL, account TEXT NOT NULL, recipient TEXT,
  content_hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'ready', slot_at INTEGER NOT NULL, slot_why TEXT NOT NULL DEFAULT 'next',
  pressed_at INTEGER, disclosure TEXT, acted_at INTEGER, proof_url TEXT, screenshot TEXT, error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX team_act_tickets_item ON team_act_tickets(item_id) WHERE state <> 'cancelled';
CREATE TABLE team_act_holds (space_id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE, held_at INTEGER NOT NULL);
`;

const TABLES = ["spaces", "settings", "team_roles", "team_reviews", "team_review_items", "team_activity", "vault_grants",
  "team_handoffs", "lab_devices", "team_act_tickets", "team_act_holds"];

const NATHAN = [
  "# Nathan Beyenhof",
  "- Status: signed · contract v3",
  "- Contact: Nathan.beyenhof@gmail.com · iMessage",
  "",
  "## Deal",
  "- Rate: $5 per video + $2.50 CPM · paid by Venmo",
  "",
  "## Accounts",
  "- TikTok @versed.nathan · vault: tiktok.com/nathan · device: Lab iPhone 2 · consent: contract §4",
  "- Instagram @versed.nathan · vault: instagram.com/nathan · device: Lab iPhone 2",
  "- YouTube Shorts: waiting on Nathan",
  "",
].join("\n");

const T = (channel?: string, account?: string, to?: string) => JSON.stringify({ ...(channel ? { channel } : {}), ...(account ? { account } : {}), ...(to ? { to } : {}) });
const NATHAN_PATH = "creators/nathan-beyenhof.md";

/** Every review the fixture holds: id, kind, state, version, record, and its items by version. */
const REVIEWS: { id: string; kind: string; state: string; version: number; record: string | null; note?: string;
  items: { id: string; version: number; files: string[]; body: string | null; target: string | null; approved: boolean }[] }[] = [
  { id: "RV1", kind: "slideshows", state: "approved", version: 2, record: NATHAN_PATH, items: [
    { id: "I11", version: 1, files: ["deck/v1/01.png", "deck/v1/02.png"], body: "first cut #ad", target: T("TikTok", "@versed.nathan"), approved: false },
    { id: "I12", version: 1, files: ["deck/v2/01.png"], body: "second cut #ad", target: T("TikTok", "@versed.nathan"), approved: false },
    { id: "I21", version: 2, files: ["deck/v1/01.png", "deck/v1/02.png"], body: "highlighting feels like studying #ad", target: T("TikTok", "@versed.nathan"), approved: true },
    { id: "I22", version: 2, files: ["deck/v2/01.png"], body: "say it back #ad", target: T("TikTok", "@versed.nathan"), approved: true },
  ] },
  { id: "RV2", kind: "message", state: "waiting", version: 1, record: NATHAN_PATH, items: [
    { id: "I31", version: 1, files: [], body: "thanks for the repost!", target: T("Instagram", "@versed.nathan", "@reader"), approved: false },
  ] },
  { id: "RV3", kind: "message", state: "changes", version: 1, record: NATHAN_PATH, note: "Make it warmer.", items: [
    { id: "I41", version: 1, files: [], body: "Hi Nathan,\n\nTwo more by Thursday?\n\nCarlton", target: T("Email", "carlton@versed.app", "nathan@example.com"), approved: false },
  ] },
  { id: "RV4", kind: "document", state: "done", version: 1, record: null, items: [
    { id: "I51", version: 1, files: ["briefs/brief.md"], body: null, target: null, approved: true },
  ] },
  { id: "RV5", kind: "report", state: "dismissed", version: 1, record: null, items: [
    { id: "I61", version: 1, files: [], body: "Sign-ups rose 12% after Thursday's post.", target: null, approved: false },
  ] },
  { id: "RV6", kind: "message", state: "waiting", version: 1, record: NATHAN_PATH, items: [
    { id: "I71", version: 1, files: [], body: "Weekly check-in", target: T("Email"), approved: false },
  ] },
  { id: "RV7", kind: "slideshows", state: "waiting", version: 1, record: NATHAN_PATH, items: [
    { id: "I81", version: 1, files: ["deck/v3/01.png"], body: "no disclosure here", target: T(undefined, "@versed.nathan"), approved: false },
  ] },
  { id: "RV8", kind: "slideshows", state: "approved", version: 1, record: NATHAN_PATH, items: [
    { id: "I91", version: 1, files: ["deck/v3/02.png"], body: "phone face down #ad", target: T("TikTok", "@versed.nathan"), approved: true },
  ] },
];

/** A v50 home with a Versed team in every state, a researcher-only team, and a space with no team. */
function v50Home(): { db: DatabaseSync; repo: string } {
  const dir = tempDir("realm-deliverables-db-");
  const db = new DatabaseSync(join(dir, "realm.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(V50);
  for (let v = 1; v <= V52_AT; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, 1)").run(v);
  db.exec("INSERT INTO spaces (id, name) VALUES ('sp1', 'Versed'), ('sp2', 'Reading'), ('sp3', 'Notes')");
  db.exec(`INSERT INTO settings (key, value_json) VALUES ('team.weekBudget:sp1', '60'), ('team.maxLive:sp1', '2'), ('ui.theme', '"dark"')`);
  const role = db.prepare(`INSERT INTO team_roles (id, space_id, name, brief, realmite_json, template, agent_kind, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, '{"seed":"x"}', ?, 'claude', 'sonnet', ?, ?)`);
  role.run("RCM", "sp1", "Creator Manager", "Keep each creator's record.", "creator-manager", 10, 10);
  role.run("RCP", "sp1", "Content Producer", "Make slideshows.", "content-producer", 11, 11);
  role.run("RRS", "sp1", "Researcher", "Look things up.", "researcher", 12, 12);
  role.run("RPB", "sp1", "Podcast Booker", "Pitch podcast hosts.", null, 13, 13);
  role.run("R2RS", "sp2", "Researcher", "Look things up.", "researcher", 14, 14);
  db.prepare("UPDATE team_roles SET handoffs_json = '[\"RCP\"]', wake_on_mention = 0 WHERE id = 'RCM'").run();
  const review = db.prepare(`INSERT INTO team_reviews (id, space_id, role_id, run_id, session_id, record_path, kind, title, state, note, version, created_at, decided_at, updated_at)
    VALUES (?, 'sp1', 'RCP', NULL, 'S1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const item = db.prepare(`INSERT INTO team_review_items (id, review_id, version, ord, files_json, body, target_json, content_hash, approved_hash, act_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  REVIEWS.forEach((r, n) => {
    review.run(r.id, r.record, r.kind, `${r.kind} ${n + 1}`, r.state, r.note ?? null, r.version, 100 + n, r.state === "waiting" ? null : 200 + n, 300 + n);
    const ord = new Map<number, number>();
    for (const it of r.items) {
      const o = ord.get(it.version) ?? 0; ord.set(it.version, o + 1);
      item.run(it.id, r.id, it.version, o, JSON.stringify(it.files), it.body, it.target, `hash-${it.id}`, it.approved ? `hash-${it.id}` : null, it.approved ? "ready" : "none");
    }
  });
  const ticket = db.prepare(`INSERT INTO team_act_tickets (id, space_id, review_id, item_id, kind, channel, account, recipient, content_hash, state, slot_at, slot_why,
      pressed_at, disclosure, acted_at, proof_url, screenshot, error, created_at, updated_at)
    VALUES (?, 'sp1', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'next', ?, ?, ?, ?, ?, ?, 400, 401)`);
  ticket.run("T1", "RV1", "I21", "post", "TikTok", "@versed.nathan", null, "hash-I21", "done", 500, 450, "caption", 510, "https://fake.invalid/tiktok/1", "/home/team-proof/sp1/T1.png", null);
  ticket.run("T2", "RV1", "I22", "post", "TikTok", "@versed.nathan", null, "hash-I22", "scheduled", 8_000, 460, "caption", null, null, null, null);
  ticket.run("T3", "RV1", "I11", "post", "TikTok", "@versed.nathan", null, "hash-I11", "cancelled", 300, null, null, null, null, null, "a newer version replaced it");
  ticket.run("T4", "RV2", "I31", "dm", "Instagram", "@versed.nathan", "@reader", "hash-I31", "ready", 9_000, null, null, null, null, null, null);
  ticket.run("T5", "RV3", "I41", "email", "Email", "carlton@versed.app", "nathan@example.com", "hash-I41", "acting", 600, 590, null, null, null, null, null);
  db.exec("INSERT INTO team_act_holds (space_id, held_at) VALUES ('sp2', 700)");
  db.exec(`INSERT INTO vault_grants (secret_id, space_id, role_id, kind, name, hosts_json, purpose, created_at) VALUES ('sec1', 'sp1', 'RCM', 'login', 'tiktok.com/nathan', '["tiktok.com"]', 'post', 800)`);
  db.exec(`INSERT INTO team_handoffs (id, space_id, kind, from_role_id, to_role_id, record_path, note, files_json, created_at) VALUES ('H1', 'sp1', 'handoff', 'RCM', 'RCP', '${NATHAN_PATH}', 'make two more', '[]', 900)`);
  db.exec(`INSERT INTO lab_devices (id, kind, udid, name, space_id, accounts_json, created_at, updated_at) VALUES ('D1', 'iphone', 'u-1', 'Lab iPhone 2', 'sp1', '[{"service":"tiktok","handle":"@versed.nathan"}]', 1000, 1000)`);
  const line = db.prepare("INSERT INTO team_activity (id, space_id, ts, actor, run_id, session_id, verb, object, detail_json) VALUES (?, 'sp1', ?, ?, NULL, NULL, ?, ?, ?)");
  for (let i = 0; i < 40; i++) line.run(`A${String(i).padStart(2, "0")}`, 1_000 + i, i % 2 ? "user" : "role:RCP", ["submitted", "approved", "pressed", "acted"][i % 4]!, `thing ${i}`, JSON.stringify({ n: i }));
  // The team's memory: Nathan's record, the template, a free-form note, and a folder that is not a type yet.
  const repo = join(dir, "memory");
  for (const d of [".git", "creators", "leads"]) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, NATHAN_PATH), NATHAN);
  writeFileSync(join(repo, "creators/_template.md"), "# Name\n- Status: prospect\n");
  writeFileSync(join(repo, "creators/notes.md"), "Free-form notes, not a record.\n");
  writeFileSync(join(repo, "leads/acme.md"), "# Acme Corp\n- Status: contacted\n");
  return { db, repo };
}

const columns = (db: DatabaseSync, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
const snapshot = (db: DatabaseSync, cols: Record<string, string[]>) =>
  Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT ${cols[t]!.map((c) => `"${c}"`).join(", ")} FROM ${t} ORDER BY rowid`).all()]));
const migrate = (db: DatabaseSync) => db.exec(migrations[V52_AT]!);

/** A TeamService over the fixture: no runs, no folder (so nothing is re-hashed), and a day with one act gone. */
function service(db: DatabaseSync, repo: string) {
  const store = new TeamStore(db, () => 2_000);
  const acts = {
    issue: () => [], cancelForReview: () => {}, tickets: () => [], counts: () => ({ total: 0, done: 0 }), held: () => false,
    today: (kind: ActKind) => ({ count: 1, cap: ACT_PACING[kind].perDay }),
  };
  // v51 is not in this fixture, so the team keeps no types: records read from v50's creators/.
  const recordTypes = new RecordTypeService({ store: new RecordTypeStore(db), repoPath: () => repo, spaceExists: () => true, log: () => {}, changed: () => {} });
  const team = new TeamService({
    store, acts, recordTypes,
    runs: { get: () => null, listLive: () => [], spentSince: () => 0 } as never,
    schedules: {} as never, sessions: { publishServerEvent: () => {} } as never,
    repos: { config: () => ({ path: repo }) } as never,
    rootForSpace: () => null, spaceExists: () => true,
    settings: { get: () => undefined, set: () => {} }, rpc: { broadcast: () => {} },
  });
  return { team, store };
}

/** What v50 said about each review, written out by hand from its `checks()`. */
const V50_CHECKS: Record<string, { ok: boolean | null; title: string; detail: string }[]> = {
  RV1: [
    { ok: true, title: "Posts as @versed.nathan on TikTok", detail: "Nathan Beyenhof's account, managed with their consent (contract §4)" },
    { ok: true, title: "Disclosed as paid partnership", detail: "Every caption says so" },
    { ok: true, title: "1 of 3 posts today for this account", detail: "Realm spaces posts at least 2 hours apart" },
  ],
  RV2: [
    { ok: false, title: "@versed.nathan has no consent on record", detail: "Add consent: to the account's line in the record before it is posted" },
    { ok: true, title: "1 of 15 DMs today for this account", detail: "Realm spaces DMs at least 3 minutes apart" },
  ],
  RV3: [
    { ok: false, title: "carlton@versed.app has no consent on record", detail: "Add consent: to the account's line in the record before it is posted" },
    { ok: true, title: "1 of 20 emails today for this account", detail: "Realm spaces emails at least 1 minutes apart" },
  ],
  RV4: [{ ok: null, title: "Realm does not post this", detail: "It names no account. Approving marks it ready; post it by hand from the space folder." }],
  RV5: [{ ok: null, title: "Realm does not post this", detail: "It names no account. Approving marks it ready; post it by hand from the space folder." }],
  RV6: [{ ok: null, title: "Realm does not send this", detail: "It names no account and no one to send it to. Approving marks it ready; send it yourself." }],
  RV7: [
    { ok: true, title: "Posts as @versed.nathan on TikTok", detail: "Nathan Beyenhof's account, managed with their consent (contract §4)" },
    { ok: false, title: "No paid-partnership disclosure in the caption", detail: "Turn on the platform's paid-partnership label when you post, or add #ad" },
    { ok: null, title: "Realm does not post this", detail: "It names no account. Approving marks it ready; post it by hand from the space folder." },
  ],
  RV8: [
    { ok: true, title: "Posts as @versed.nathan on TikTok", detail: "Nathan Beyenhof's account, managed with their consent (contract §4)" },
    { ok: true, title: "Disclosed as paid partnership", detail: "Every caption says so" },
    { ok: true, title: "1 of 3 posts today for this account", detail: "Realm spaces posts at least 2 hours apart" },
  ],
};

describe("migration v52 — generic deliverables, on a hand-written v50 home", () => {
  it("is appended after the act tickets, found by its text", () => {
    const acts = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS team_act_tickets"));
    expect(V52_AT).toBeGreaterThan(acts);
  });

  it("loses nothing: every v50 column of every row of every table is as it was, and the row counts with it", () => {
    const { db } = v50Home();
    const v50 = Object.fromEntries(TABLES.map((t) => [t, columns(db, t)]));
    const before = snapshot(db, v50);
    migrate(db);
    // THE MUTANT: a backfill that rewrites `target_json`, or one that touches a row it should not.
    expect(snapshot(db, v50)).toEqual(before);
    expect(columns(db, "team_review_items")).toEqual([...v50.team_review_items!, "meta_json", "format", "action_json", "edited_by"]);
    for (const t of TABLES.filter((x) => x !== "team_review_items")) expect(columns(db, t), t).toEqual(v50[t]);
  });

  it("gives every legacy item the action actKindFor always made of it — and none to an item that names no channel and account", () => {
    const { db } = v50Home();
    migrate(db);
    const rows = db.prepare(`SELECT i.id, r.kind, i.target_json, i.action_json, i.format, i.meta_json, i.edited_by FROM team_review_items i
      JOIN team_reviews r ON r.id = i.review_id ORDER BY i.id`).all() as { id: string; kind: string; target_json: string | null; action_json: string | null; format: string | null; meta_json: string; edited_by: string | null }[];
    expect(rows).toHaveLength(REVIEWS.flatMap((r) => r.items).length);
    for (const row of rows) {
      const target = row.target_json ? JSON.parse(row.target_json) as { channel?: string; account?: string; to?: string } : null;
      const verb = actKindFor(row.kind, target?.channel);
      const action = row.action_json ? JSON.parse(row.action_json) as ReviewAction : null;
      // THE MUTANT: the `dm` branch for every message (emails become DMs), or the account guard dropped.
      if (verb && target?.account) {
        expect(action, row.id).toEqual({ verb, connector: `channel:${target.channel!.trim().toLowerCase()}`, account: target.account, to: target.to ?? null, legacy: 1 });
      } else {
        expect(action, row.id).toBeNull();
      }
      expect(row.format, row.id).toBe(row.kind === "slideshows" ? "images" : null);
      expect(row.meta_json).toBe("{}");
      expect(row.edited_by).toBeNull();
    }
    // The fixture covers each branch, so the loop above cannot pass vacuously.
    expect(rows.filter((r) => r.action_json).map((r) => r.id)).toEqual(["I11", "I12", "I21", "I22", "I31", "I41", "I91"]);
  });

  it("reads every review's checks exactly as v50 did, and its summary's channels as written", () => {
    const { db, repo } = v50Home();
    migrate(db);
    const { team } = service(db, repo);
    // The record the checks read is the fixture's own file.
    expect(parseRecord(NATHAN)?.title).toBe("Nathan Beyenhof");
    for (const r of REVIEWS) {
      // THE MUTANT: the disclosure check read off the verb family without the account guard, or the
      // legacy fallbacks' words changed — each legacy review's checks drift.
      expect(team.review(r.id).checks, r.id).toEqual(V50_CHECKS[r.id]);
    }
    expect(team.review("RV1")).toMatchObject({ kind: "slideshows", channels: ["TikTok"], account: "@versed.nathan", format: "images" });
    expect(team.review("RV3")).toMatchObject({ channels: ["Email"], account: "carlton@versed.app", format: "email" });
  });

  it("issues a legacy approved item's ticket exactly as before: its kind, and its channel as the target wrote it", () => {
    const { db, repo } = v50Home();
    migrate(db);
    const { store } = service(db, repo);
    const acts = new ActService({
      store: new ActStore(db, () => new Date(2026, 9, 9, 14).getTime()), team: store, rootForSpace: () => null,
      record: () => parseRecord(NATHAN), presses: { consume: async () => ({ pressed: false, label: false, slotAt: null }) },
      adapter: () => ({ status: () => ({ connected: false, label: "x", why: "x" }), act: async () => ({ ok: false, error: "x", screenshot: null }) }),
      proofDir: join(repo, "..", "proof"), rpc: { broadcast: () => {} } as never, clock: () => new Date(2026, 9, 9, 14).getTime(),
    });
    const issued = acts.issue("RV8");
    // THE MUTANT: the channel read off the backfilled connector — "tiktok" where every ticket before said "TikTok".
    expect(issued.map((t) => ({ kind: t.kind, channel: t.channel, account: t.account, to: t.to }))).toEqual([{ kind: "post", channel: "TikTok", account: "@versed.nathan", to: null }]);
    // And the tickets that were already there are untouched by issuing more.
    expect(acts.issue("RV1").map((t) => [t.id, t.state])).toEqual([["T1", "done"], ["T2", "scheduled"]]);
  });

  it("is idempotent: its updates met again change no row", () => {
    const { db } = v50Home();
    migrate(db);
    const all = Object.fromEntries(TABLES.map((t) => [t, columns(db, t)]));
    const once = snapshot(db, all);
    // The runner never re-runs a version; this is the backfill alone, met twice, ALTERs left out.
    db.exec(migrations[V52_AT]!.split(";").filter((s) => !/ALTER TABLE/.test(s)).join(";"));
    expect(snapshot(db, all)).toEqual(once);
  });

  it("leaves an item written since its own: a new action and format are never overwritten", () => {
    const { db } = v50Home();
    migrate(db);
    db.prepare(`UPDATE team_review_items SET action_json = '{"connector":"mcp:gmail","verb":"send"}', format = 'email' WHERE id = 'I21'`).run();
    db.exec(migrations[V52_AT]!.split(";").filter((s) => !/ALTER TABLE/.test(s)).join(";"));
    expect(db.prepare("SELECT action_json, format FROM team_review_items WHERE id = 'I21'").get()).toEqual({ action_json: '{"connector":"mcp:gmail","verb":"send"}', format: "email" });
  });
});
