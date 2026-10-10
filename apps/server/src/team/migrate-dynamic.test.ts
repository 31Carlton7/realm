import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import { CREATOR_PRESET, creatorRecordTemplate, recordTemplate, type Run } from "@realm/contracts";
import { openDatabase, type Db } from "../db/database";
import { migrations } from "../db/migrations";
import { createApp, type App } from "../app";
import { workerPreamble } from "../runs/service";
import { TeamStore } from "./store";
import { RecordTypeStore } from "./record-types/store";
import { RecordTypeService } from "./record-types/service";
import { adoptRecordTypes } from "./record-types/adopt";
import { BARE, RESEARCH, REVIEW, ROLE, SHOP, STUDIO, V50_SCHEMA, V50_TABLES, VERSED, columnsOf, fixtureRepos, snapshot, v50Rows } from "./v50-fixture";

/**
 * Dynamic Teams' migrations against a hand-written v50 home (`v50-fixture.ts`): what RC2 leaves on disk,
 * written out rather than replayed from `migrations`, because a replayed fixture agrees with any
 * mutation of the list it was built from. Each migration is found by its text — a merge may reorder
 * them — and each PR adds its own assertions here.
 */
const V51_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS team_record_types"));
const ACTS_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS team_act_tickets"));

function v50Home(): { path: string; root: string } {
  const root = tempDir("realm-v50-");
  const repos = fixtureRepos(root);
  const path = join(root, "realm.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  db.exec(V50_SCHEMA);
  for (let v = 1; v <= V51_AT; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, 1);
  db.exec(v50Rows({ root, repos, later: Date.now() + 3 * 86_400_000 }));
  db.close();
  return { path, root };
}

/** The fixture as it stands before any migration ran: every row, and every table's v50 columns. */
function before(path: string) {
  const raw = new DatabaseSync(path);
  const columns = columnsOf(raw);
  const rows = snapshot(raw, V50_TABLES, columns);
  raw.close();
  return { columns, rows };
}

const meta = (db: Db) => db.prepare("SELECT space_id, template, template_version, created_at FROM team_meta ORDER BY space_id").all();
const types = (db: Db) => (db.prepare("SELECT * FROM team_record_types ORDER BY space_id, key").all() as Record<string, unknown>[]);

describe("migration v51 — record types", () => {
  it("is found by its text, after the act tickets", () => {
    expect(ACTS_AT).toBeGreaterThan(-1);
    expect(V51_AT).toBeGreaterThan(ACTS_AT);
  });

  it("loses nothing: every v50 row of every table is byte-equal after, on its v50 columns", () => {
    const { path } = v50Home();
    const was = before(path);
    const db = openDatabase(path);
    expect(snapshot(db, V50_TABLES, was.columns)).toEqual(was.rows);
    for (const t of V50_TABLES) expect((db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n, t).toBe(was.rows[t]!.length);
    // …and the new tables hold exactly what the backfill says: four meta rows, three Creator types.
    expect(meta(db)).toHaveLength(4);
    expect(types(db).map((t) => [t.space_id, t.key])).toEqual([[VERSED, "creator"], [STUDIO, "creator"], [SHOP, "creator"]].sort((a, b) => a[0]!.localeCompare(b[0]!)));
    db.close();
  });

  it("classes Versed as creator campaigns, with the Creator type exactly as v50 kept a record", () => {
    const { path } = v50Home();
    const db = openDatabase(path);
    const m = meta(db) as { space_id: string; template: string | null; template_version: number | null; created_at: number }[];
    // Dated from the team's first role — the custom one, archived roles included.
    const first = (db.prepare("SELECT MIN(created_at) AS t FROM team_roles WHERE space_id = ?").get(VERSED) as { t: number }).t;
    expect(m.find((x) => x.space_id === VERSED)).toEqual({ space_id: VERSED, template: "creator-campaigns", template_version: 1, created_at: first });
    const t = types(db).find((x) => x.space_id === VERSED)!;
    expect(t).toMatchObject({ key: CREATOR_PRESET.key, one: "Creator", many: "Creators", folder: "creators", glyph: "records", title_field: "#", status_field: "Status", preset: "creator", archived: 0, created_at: first, updated_at: first });
    // THE mutant: a section dropped or reshaped in the SQL — v51 and the preset must say the same thing.
    expect(JSON.parse(t.sections_json as string)).toEqual(CREATOR_PRESET.sections);
    expect(JSON.parse(t.head_json as string)).toEqual(CREATOR_PRESET.head);
    expect(JSON.parse(t.statuses_json as string)).toEqual(CREATOR_PRESET.statuses);
    expect(t.id).toMatch(/^[0-9A-F]{26}$/);
    // …and the record that type starts is v50's template, byte for byte.
    const asType = { titleField: t.title_field as string, statusField: t.status_field as string, statuses: JSON.parse(t.statuses_json as string), sections: JSON.parse(t.sections_json as string) };
    for (const name of ["Nathan Beyenhof", "Zoë", "a"]) expect(recordTemplate(asType, name)).toBe(creatorRecordTemplate(name));
    db.close();
  });

  it("classes a team by what it did, too: slideshows sent to Review, or a ticket an approval issued", () => {
    const { path } = v50Home();
    const db = openDatabase(path);
    const m = meta(db) as { space_id: string; template: string | null }[];
    expect(m.find((x) => x.space_id === STUDIO)?.template).toBe("creator-campaigns");
    expect(m.find((x) => x.space_id === SHOP)?.template).toBe("creator-campaigns");
    db.close();
  });

  it("leaves the researcher's team unclassed and without a type — a review about a leads/ record is not a creator signal", () => {
    // THE mutant: the review signal reading `record_path LIKE 'leads/%'` (or any record path) as creator.
    const { path } = v50Home();
    const db = openDatabase(path);
    expect((meta(db) as { space_id: string; template: string | null; template_version: number | null }[]).find((x) => x.space_id === RESEARCH))
      .toMatchObject({ template: null, template_version: null });
    expect(types(db).filter((x) => x.space_id === RESEARCH)).toEqual([]);
    db.close();
  });

  it("gives a space with no team nothing", () => {
    const { path } = v50Home();
    const db = openDatabase(path);
    expect(db.prepare("SELECT COUNT(*) AS n FROM team_meta WHERE space_id = ?").get(BARE)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM team_record_types WHERE space_id = ?").get(BARE)).toEqual({ n: 0 });
    db.close();
  });

  it("is idempotent: its SQL met again changes no row, and a reopened home re-runs nothing", () => {
    const { path } = v50Home();
    const db = openDatabase(path);
    const tables = [...V50_TABLES, "team_meta", "team_record_types"];
    const once = snapshot(db, tables);
    db.exec(migrations[V51_AT]!);
    expect(snapshot(db, tables)).toEqual(once);
    db.close();
    const again = openDatabase(path);
    expect((again.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as { n: number }).n).toBe(migrations.length);
    expect(snapshot(again, tables)).toEqual(once);
    again.close();
  });

  it("goes with its space: a deleted team takes its meta and its types, and only its own", () => {
    const { path } = v50Home();
    const db = openDatabase(path);
    db.prepare("DELETE FROM spaces WHERE id = ?").run(STUDIO);
    expect(types(db).map((t) => t.space_id).sort()).toEqual([SHOP, VERSED].sort());
    expect((meta(db) as { space_id: string }[]).map((x) => x.space_id).sort()).toEqual([RESEARCH, SHOP, VERSED].sort());
    db.close();
  });

  it("holds one type per key and one per folder in a space", () => {
    const { path } = v50Home();
    const db = openDatabase(path);
    const insert = (key: string, folder: string) => db.prepare(`INSERT INTO team_record_types (id, space_id, key, one, many, folder, created_at, updated_at)
      VALUES (hex(randomblob(13)), ?, ?, 'X', 'Xs', ?, 1, 1)`).run(VERSED, key, folder);
    expect(() => insert("creator", "elsewhere")).toThrow(/UNIQUE/);
    expect(() => insert("lead", "creators")).toThrow(/UNIQUE/);
    insert("lead", "leads");
    db.close();
  });

  it("brings a v41 home — the real home's path, with no team table — to the end of the chain with nothing to class", () => {
    const p = join(tempDir("realm-v41-"), "realm.db");
    const raw = new DatabaseSync(p);
    raw.exec("PRAGMA foreign_keys = ON;");
    raw.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (let v = 0; v < 41; v++) { raw.exec(migrations[v]!); raw.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, 1)").run(v + 1); }
    raw.exec("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES ('01PF0000000000000000000001', 'P', 'x', '#000', 0, 1, 1)");
    raw.close();
    const db = openDatabase(p);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect(db.prepare("SELECT COUNT(*) AS n FROM team_meta").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM team_record_types").get()).toEqual({ n: 0 });
    db.close();
  });
});

/** The boot reconcile over the migrated fixture, as app.ts wires it. */
function reconciler(db: Db) {
  const team = new TeamStore(db);
  const store = new RecordTypeStore(db);
  const repoPath = (spaceId: string) => {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`memory.repo:space:${spaceId}`) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as { path: string }).path : null;
  };
  const service = new RecordTypeService({
    store, repoPath, spaceExists: () => true,
    log: (spaceId, actor, verb, object, detail) => { team.appendActivity({ spaceId, actor, verb, object, detail }); },
    changed: () => {},
  });
  return { run: () => adoptRecordTypes({ teamSpaceIds: () => team.teamSpaceIds(), repoPath, store, types: service }), service };
}

const adoptions = (db: Db) => db.prepare("SELECT space_id, object, detail_json FROM team_activity WHERE verb = 'adopted_record_type' ORDER BY space_id, object").all() as { space_id: string; object: string; detail_json: string }[];

describe("the boot reconcile — what v51 cannot see from SQL", () => {
  it("adopts a folder of records no type claims: Versed's leads/, and the researcher's hand-made creators/", () => {
    const { path } = v50Home();
    const db = openDatabase(path);
    const { run, service } = reconciler(db);
    expect(run().map((a) => [a.spaceId, a.folder, a.key]).sort()).toEqual([[RESEARCH, "creators", "creator"], [VERSED, "leads", "lead"]].sort());
    // The researcher's team gets the Creator preset itself, not a type guessed from Nathan's file.
    const creator = service.list(RESEARCH).find((t) => t.key === "creator")!;
    expect(creator).toMatchObject({ preset: "creator", sections: CREATOR_PRESET.sections, head: CREATOR_PRESET.head });
    // A plain type for leads/, named from the folder, with what acme.md actually uses.
    expect(service.list(VERSED).find((t) => t.folder === "leads")).toMatchObject({
      key: "lead", one: "Lead", many: "Leads", preset: null, statusField: "Status", statuses: ["contacted"],
      head: [{ key: "Status" }, { key: "Contact" }, { key: "Sends from" }],
      sections: [{ heading: "People", shape: "entries", parts: ["role", "contact"] }, { heading: "Touches", shape: "list", dated: true }],
    });
    expect(adoptions(db).map((a) => [a.space_id, a.object])).toEqual([[VERSED, "Leads"], [RESEARCH, "Creators"]].sort((a, b) => a[0]!.localeCompare(b[0]!)));
    db.close();
  });

  it("adds only: Versed's Creator type, its rows and its meta are as v51 left them", () => {
    const { path } = v50Home();
    const db = openDatabase(path);
    const tables = [...V50_TABLES.filter((t) => t !== "team_activity"), "team_meta"];
    const was = snapshot(db, tables);
    const creatorBefore = types(db).find((t) => t.space_id === VERSED);
    reconciler(db).run();
    expect(snapshot(db, tables)).toEqual(was);
    expect(types(db).find((t) => t.space_id === VERSED && t.key === "creator")).toEqual(creatorBefore);
    db.close();
  });

  it("is idempotent: run twice, one adoption line each, and nothing new the second time", () => {
    const { path } = v50Home();
    const db = openDatabase(path);
    const { run } = reconciler(db);
    run();
    const lines = adoptions(db).length;
    const rows = types(db);
    expect(run()).toEqual([]);
    expect(adoptions(db)).toHaveLength(lines);
    expect(types(db)).toEqual(rows);
    db.close();
  });
});

/* ═══════════════════════════════ behaviour, on the real app ═══════════════════════════════ */

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; });

/** The same rows on a home whose schema was replayed to v50, so the real app can boot on it. */
function bootableV50Home(o: { leads?: boolean } = {}): string {
  const home = tempDir("realm-v50-app-");
  const repos = fixtureRepos(home, o);
  for (const name of ["versed", "research", "bare", "studio", "shop"]) mkdirSync(join(home, "spaces", name), { recursive: true });
  const raw = new DatabaseSync(join(home, "realm.db"));
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (let v = 0; v < V51_AT; v++) { raw.exec(migrations[v]!); raw.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, 1)").run(v + 1); }
  raw.exec(v50Rows({ root: join(home, "spaces"), repos, later: Date.now() + 3 * 86_400_000 }));
  raw.close();
  return home;
}

const boot = async (home: string) => {
  app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) } });
  return app;
};

/** v50's preamble, written out as RC2 wrote it — the records line included. */
const V50_RECORDS = "- Records are Markdown files under `creators/` in the team's memory. Read them with `record_list` and `record_read`; change them with `record_update`. An account names where its sign-in is kept, never a password or key.";
const v50Preamble = (name: string, extra: string[] = []) => [
  workerPreamble(`You are ${name}, a standing role on this space's team.\n\n${name}'s brief: keep creators/ current.`),
  "",
  "Team rules (Realm):",
  "- Deliver with `review_submit` (the realm-team tools). Never send, post, sign or pay: a person approves everything in Review, then presses each post or send themselves, one at a time, at Realm's paced slots. No tool lets you post, send or DM, and none ever will.",
  V50_RECORDS,
  "- Save what you make inside this space's folder; Review only takes files from there.",
  "- This run stops at $3 or 20 minutes, whichever comes first.",
  ...extra,
].join("\n");

describe("behaviour after v51, on the fixture home", () => {
  const VAULT_LINE = "- The team's vault: you use these by name and never see a value. Sign-ins, through `browser_fill_credential`: tiktok.com/nathan. `vault_list` says what you hold. Anything else is refused.";

  it("tells each of Versed's roles exactly what v50 told it — the records line generated from the Creator type", async () => {
    // Versed's repo as RC2 left it with creators/ only: one type, so v50's sentence, byte for byte.
    const a = await boot(bootableV50Home({ leads: false }));
    expect(a.team.space(VERSED).recordTypes.map((t) => t.key)).toEqual(["creator"]);
    expect(a.team.rolePreamble({ roleId: ROLE.manager } as Run)).toBe(v50Preamble("Creator Manager"));
    expect(a.team.rolePreamble({ roleId: ROLE.producer } as Run)).toBe(v50Preamble("Content Producer", [VAULT_LINE]));
    expect(a.team.rolePreamble({ roleId: ROLE.researcher } as Run)).toBe(v50Preamble("Researcher"));
    expect(a.team.rolePreamble({ roleId: ROLE.custom } as Run)).toBe(v50Preamble("Deal Desk"));
  });

  it("names leads/ beside creators/ once the reconcile adopts it, and changes nothing else a role is told", async () => {
    const a = await boot(bootableV50Home());
    const both = "- Records are Markdown files in the team's memory: `creators/` (Creator: Deal, Accounts, Deadlines, Content) and `leads/` (Lead: People, Touches). Read them with `record_list` and `record_read`; change them with `record_update`, naming the `type` when you make one. An account names where its sign-in is kept, never a password or key.";
    expect(a.team.rolePreamble({ roleId: ROLE.producer } as Run)).toBe(v50Preamble("Content Producer", [VAULT_LINE]).replace(V50_RECORDS, both));
  });

  it("checks every review as v50 did", async () => {
    const a = await boot(bootableV50Home());
    const nathan = { ok: true, detail: "Nathan Beyenhof's account, managed with their consent (contract §4)" };
    expect(a.team.review(REVIEW.slides).checks).toEqual([
      { ...nathan, title: "Posts as @versed.nathan on TikTok" },
      { ok: true, title: "Disclosed as paid partnership", detail: "Every caption says so" },
      { ok: true, title: "0 of 3 posts today for this account", detail: "Realm spaces posts at least 2 hours apart" },
    ]);
    expect(a.team.review(REVIEW.dm).checks).toEqual([
      { ...nathan, title: "Sends as @versed.nathan on Instagram" },
      { ok: true, title: "0 of 15 DMs today for this account", detail: "Realm spaces DMs at least 3 minutes apart" },
    ]);
    expect(a.team.review(REVIEW.email).checks).toEqual([
      { ok: false, title: "carlton@charmtechnologies.co has no consent on record", detail: "Add consent: to the account's line in the record before it is posted" },
      { ok: true, title: "0 of 20 emails today for this account", detail: "Realm spaces emails at least 1 minutes apart" },
    ]);
    const unaimed = [{ ok: null, title: "Realm does not post this", detail: "It names no account. Approving marks it ready; post it by hand from the space folder." }];
    expect(a.team.review(REVIEW.doc).checks).toEqual(unaimed);
    expect(a.team.review(REVIEW.report).checks).toEqual(unaimed);
  });

  it("reads Versed's records where v50 did, and its hand-made leads/ beside them once adopted at boot", async () => {
    const a = await boot(bootableV50Home());
    expect(a.team.records(VERSED, "creators").map((r) => r.path)).toEqual(["creators/nathan-beyenhof.md", "creators/notes.md"]);
    expect(a.team.records(VERSED, "creators").map((r) => r.kind)).toEqual(["creator", "creator"]);
    expect(a.team.records(VERSED).map((r) => r.path)).toEqual(["creators/nathan-beyenhof.md", "creators/notes.md", "leads/acme.md"]);
    const space = a.team.space(VERSED);
    expect(space.recordTypes.map((t) => [t.key, t.folder, t.count])).toEqual([["creator", "creators", 2], ["lead", "leads", 1]]);
    expect(space.recordCount).toBe(3);
    // A path RC2 stored still resolves: the handoff's and the reviews' `creators/nathan-beyenhof.md`.
    expect(a.team.recordFor(VERSED, "creators/nathan-beyenhof.md")?.title).toBe("Nathan Beyenhof");
  });

  it("boots twice with no new activity the second time", async () => {
    const home = bootableV50Home();
    const count = (x: App) => (x.db.prepare("SELECT COUNT(*) AS n FROM team_activity").get() as { n: number }).n;
    const first = count(await boot(home));
    await app!.close(); app = null;
    expect(count(await boot(home))).toBe(first);
  });
});

describe("the dry run on a copy of a home", () => {
  it("reports what v51 and the reconcile would add, loses nothing, and leaves the home byte-identical", async () => {
    const { dryRunMigrations, dryRunWords } = await import("./migrate-dry-run");
    const { createHash } = await import("node:crypto");
    const { readFileSync } = await import("node:fs");
    const { path } = v50Home();
    const hash = () => createHash("sha256").update(readFileSync(path)).digest("hex");
    const was = hash();
    const r = dryRunMigrations(path);
    expect(hash()).toBe(was);
    expect(new DatabaseSync(path, { readOnly: true }).prepare("SELECT MAX(version) AS v FROM schema_version").get()).toEqual({ v: V51_AT });
    expect(r).toMatchObject({ from: V51_AT, to: migrations.length, lost: {} });
    // Four teams classed, three Creator types, then the reconcile's two adoptions and their lines.
    expect(r.added).toMatchObject({ team_meta: 4, team_record_types: 5, team_activity: 2 });
    expect(r.adoptions.map((a) => a.folder).sort()).toEqual(["creators", "leads"]);
    expect(r.teams.find((t) => t.spaceId === VERSED)).toMatchObject({ name: "Versed", template: "creator-campaigns", types: ["creator (creators/)", "lead (leads/)"] });
    expect(dryRunWords(r)).toContain("Lost or rewritten rows: none");
  });
});
