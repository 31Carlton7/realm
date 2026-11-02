import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { teammateIconFromSeed } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { migrations } from "../db/migrations";
import { registerPayloadFunction } from "../store/event-payload";
import { SchedulesStore } from "../store/schedules";
import { TeammatesStore } from "./store";

/** Found by its own text, never by number: at merge it goes last, after whatever lands beside it. */
const TEAMMATES_AT = migrations.findIndex((m) => m.includes("ALTER TABLE team_roles ADD COLUMN handle TEXT"));

/** A home at the migration before teammates, with the roles the owner made in the first Teams. */
function homeWithRoles(): string {
  const path = join(tempDir("realm-teammates-migration-"), "realm.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  registerPayloadFunction(db);
  db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (let v = 0; v < TEAMMATES_AT; v++) {
    db.exec(migrations[v]!);
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v + 1, 1);
  }
  db.exec("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES ('p', 'P', 'x', '#000', 0, 1, 1)");
  db.exec("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at) VALUES ('versed', 'p', 'Versed', 'f', 0, '/tmp/versed', 1, 1)");
  db.exec("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at) VALUES ('general', 'p', 'General', 'f', 1, '/tmp/general', 1, 1)");
  const role = db.prepare(`INSERT INTO team_roles (id, space_id, name, brief, realmite_json, template, agent_kind, model, effort, permission_mode,
      skills_json, week_budget_usd, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'claude', ?, NULL, ?, '[]', 20, ?, ?, ?)`);
  role.run("R1", "versed", "Creator Manager", "You manage this team's creators.", JSON.stringify({ v: 1, seed: "creator-manager-1586" }), "creator-manager", "sonnet", "default", 0, 10, 10);
  role.run("R2", "versed", "Content Producer", "You make short-form slideshows.", JSON.stringify({ v: 1, seed: "content-producer-32" }), "content-producer", "sonnet", "acceptEdits", 1, 11, 11);
  role.run("R3", "versed", "Viral Video Studier", "You study what went viral.", "{}", null, "claude-opus-5-5", "plan", 2, 12, 12);
  role.run("R4", "general", "Ops", "You keep this team's admin in order.", JSON.stringify({ v: 1, seed: "ops-914" }), "ops", "sonnet", "default", 0, 13, 13);
  // The clocks those roles ran on, as the owner's database holds them: a run per occurrence, each in a
  // new session, on the goal the first Teams wrote from the brief.
  const clock = db.prepare(`INSERT INTO schedules (id, space_id, title, goal, cron, enabled, constraints_json, next_run_at, last_run_at,
      last_run_id, last_skipped_at, new_session_per_run, archive_succeeded, created_at, updated_at, role_id)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, 1, 0, 10, 10, ?)`);
  for (const [id, space, role, name, cron, next, last] of CLOCKS) {
    clock.run(id, space, name, goalOf(name), cron, JSON.stringify({ agentKind: "claude", model: "sonnet", permissionMode: "default" }), next, last, role);
  }
  db.close();
  return path;
}

const goalOf = (name: string) => `${name}'s scheduled run. Do what your brief says is due now.\n\nYour brief:\n\nYou do ${name}'s work.`;
const CLOCKS = [
  ["C1", "versed", "R1", "Creator Manager", "0 9 * * 1-5", 1793638800000, 1793376013391],
  ["C2", "versed", "R2", "Content Producer", "0 9 * * 1,4", 1793638800000, 1793289653326],
  ["C4", "general", "R4", "Ops", "0 8 * * 1", 1793635200000, 1793026801373],
] as const;

describe("teammates from the first Teams' roles", () => {
  it("brings every role through as a teammate, with its name, brief and model, and keeps the old columns", () => {
    const db = openDatabase(homeWithRoles());
    const store = new TeammatesStore(db);
    expect(store.backfill()).toBe(4);

    const versed = store.list("versed");
    expect(versed.map((t) => [t.name, t.handle, t.brief, t.model])).toEqual([
      ["Creator Manager", "creator-manager", "You manage this team's creators.", "sonnet"],
      ["Content Producer", "content-producer", "You make short-form slideshows.", "sonnet"],
      ["Viral Video Studier", "viral-video-studier", "You study what went viral.", "claude-opus-5-5"],
    ]);
    expect(store.list("general").map((t) => [t.name, t.handle])).toEqual([["Ops", "ops"]]);
    for (const t of [...versed, ...store.list("general")]) {
      expect(t).toMatchObject({ folder: null, lead: false, group: null, archived: false, homeSessionId: null });
    }
    // Nothing the first Teams wrote is dropped: its own columns still read as they were.
    expect(db.prepare("SELECT template, week_budget_usd FROM team_roles WHERE id = 'R1'").get()).toEqual({ template: "creator-manager", week_budget_usd: 20 });
    db.close();
  });

  it("brings the owner's four through in Full access, the mode their runs went in, whatever their column said", () => {
    const db = openDatabase(homeWithRoles());
    const store = new TeammatesStore(db);
    store.backfill();
    const all = [...store.list("versed"), ...store.list("general")];
    expect(all.map((t) => [t.name, t.permissionMode])).toEqual([
      ["Creator Manager", "bypassPermissions"], ["Content Producer", "bypassPermissions"], ["Viral Video Studier", "bypassPermissions"], ["Ops", "bypassPermissions"],
    ]);
    // A teammate made afterwards keeps its own, however many boots follow.
    const made = store.create({ spaceId: "versed", handle: "new", name: "New", brief: "", icon: { shape: "circle", color: "blue" }, agentKind: "claude",
      model: null, effort: null, permissionMode: "default", folder: null, lead: false, group: null });
    expect(store.backfill()).toBe(0);
    expect(store.get(made.id)!.permissionMode).toBe("default");
    db.close();
  });

  it("rolls each role's icon from its Realmite's seed, or its id with none, and keeps it on every boot", () => {
    const path = homeWithRoles();
    const db = openDatabase(path);
    new TeammatesStore(db).backfill();
    const icons = Object.fromEntries(new TeammatesStore(db).list("versed").map((t) => [t.id, t.icon]));
    expect(icons.R1).toEqual(teammateIconFromSeed("creator-manager-1586"));
    expect(icons.R3).toEqual(teammateIconFromSeed("R3"));
    db.close();

    const again = openDatabase(path);
    expect(new TeammatesStore(again).backfill()).toBe(0);
    expect(Object.fromEntries(new TeammatesStore(again).list("versed").map((t) => [t.id, t.icon]))).toEqual(icons);
    again.close();
  });

  it("keeps each role's clock as its teammate's, with its expression, its switch, its goal and its next time", () => {
    const path = homeWithRoles();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE team_roles SET archived = 1 WHERE id = 'R2'");
    raw.close();
    const db = openDatabase(path);
    new TeammatesStore(db).backfill();
    const clocks = new SchedulesStore(db);
    for (const [id, , role, name, cron, next, last] of CLOCKS) {
      expect(clocks.forRole(role)).toMatchObject({ id, roleId: role, title: name, cron, enabled: true, goal: goalOf(name), nextRunAt: next, lastRunAt: last });
    }
    // The teammate's page shows it; the Scheduled page does not.
    expect(clocks.list("versed")).toEqual([]);
    // Due, it is claimed like any schedule — but not while its teammate is archived.
    expect(clocks.claimDue(1793638800000 + 1).map((c) => c.schedule.id).sort()).toEqual(["C1", "C4"]);
    expect(clocks.forRole("R2")!.nextRunAt).toBe(1793638800000);
    db.close();
  });

  it("gives two roles of one name in a space handles of their own", () => {
    const path = homeWithRoles();
    const raw = new DatabaseSync(path);
    raw.exec(`INSERT INTO team_roles (id, space_id, name, brief, realmite_json, agent_kind, permission_mode, sort_order, created_at, updated_at)
      VALUES ('R5', 'versed', 'Creator manager', 'Another.', '{}', 'claude', 'default', 3, 20, 20)`);
    raw.close();
    const db = openDatabase(path);
    const store = new TeammatesStore(db);
    store.backfill();
    expect(store.list("versed").map((t) => t.handle)).toEqual(["creator-manager", "content-producer", "viral-video-studier", "creator-manager-2"]);
    db.close();
  });
});

describe("the teammates store", () => {
  function fresh() {
    const db = openDatabase(join(tempDir("realm-teammates-store-"), "realm.db"));
    db.exec("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES ('p', 'P', 'x', '#000', 0, 1, 1)");
    db.exec("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at) VALUES ('s', 'p', 'S', 'f', 0, '/tmp/s', 1, 1)");
    return { db, store: new TeammatesStore(db) };
  }
  const base = { spaceId: "s", brief: "", icon: { shape: "circle" as const, color: "blue" as const }, agentKind: "claude" as const, model: null, effort: null,
    permissionMode: "default" as const, folder: null, lead: false, group: null };

  it("keeps one Lead per space, first in the list", () => {
    const { db, store } = fresh();
    const a = store.create({ ...base, name: "A", handle: "a" });
    const b = store.create({ ...base, name: "B", handle: "b" });
    store.setLead("s", b.id);
    expect(store.list("s").map((t) => [t.handle, t.lead])).toEqual([["b", true], ["a", false]]);
    store.setLead("s", a.id);
    expect(store.list("s").map((t) => [t.handle, t.lead])).toEqual([["a", true], ["b", false]]);
    store.setLead("s", null);
    expect(store.lead("s")).toBeNull();
    db.close();
  });

  it("orders and groups by the person's arrangement, and finds a free handle", () => {
    const { db, store } = fresh();
    const a = store.create({ ...base, name: "A", handle: "a" });
    const b = store.create({ ...base, name: "B", handle: "b" });
    store.reorder("s", [{ id: b.id, group: "Strat" }, { id: a.id, group: null }]);
    expect(store.list("s").map((t) => [t.handle, t.group])).toEqual([["b", "Strat"], ["a", null]]);
    expect(store.freeHandle("s", "a")).toBe("a-2");
    expect(store.freeHandle("s", "a", a.id)).toBe("a");
    db.close();
  });
});
