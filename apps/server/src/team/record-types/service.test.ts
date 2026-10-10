import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { CREATOR_PRESET, recordPreset } from "@realm/contracts";
import { openDatabase } from "../../db/database";
import { RecordTypeStore } from "./store";
import { RecordTypeService } from "./service";
import { adoptRecordTypes, recordsIn } from "./adopt";

const S = "01SP0000000000000000000001";

function setup() {
  const home = tempDir("realm-record-types-");
  const db = openDatabase(join(home, "realm.db"));
  db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES ('p', 'P', 'x', '#000', 0, 1, 1)").run();
  db.prepare("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at) VALUES (?, 'p', 'Versed', 'f', 0, '/tmp', 1, 1)").run(S);
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  const lines: { verb: string; object: string | null; detail: Record<string, unknown> }[] = [];
  const changed: string[] = [];
  const store = new RecordTypeStore(db);
  const types = new RecordTypeService({
    store, repoPath: () => repo, spaceExists: (id) => id === S,
    log: (_s, _a, verb, object, detail) => { lines.push({ verb, object, detail }); },
    changed: (id) => { changed.push(id); },
  });
  const file = (rel: string, text = "# X\n- Status: new\n") => { mkdirSync(join(repo, rel, ".."), { recursive: true }); writeFileSync(join(repo, rel), text); };
  return { db, repo, store, types, lines, changed, file };
}

describe("record paths", () => {
  it("are a type's folder and a name, depth two — a bare name only where the team keeps one kind", () => {
    const { types } = setup();
    // A team with no types reads as v50 did: creators/ is the one folder.
    expect(types.recordRel(S, "nathan-beyenhof")).toBe("creators/nathan-beyenhof.md");
    types.create({ spaceId: S, preset: "creator" });
    expect(types.recordRel(S, "[[creators/nathan-beyenhof]]")).toBe("creators/nathan-beyenhof.md");
    types.create({ spaceId: S, preset: "lead" });
    expect(types.recordRel(S, "leads/acme")).toBe("leads/acme.md");
    // THE mutants: a bare name guessed into the first folder, a path outside every type, a deeper path.
    expect(() => types.recordRel(S, "acme")).toThrow(/records are creators\/<name>\.md or leads\/<name>\.md/);
    for (const bad of ["notes/acme.md", "leads/../MEMORY.md", "leads/a/b.md", "../x", "leads//x.md"]) expect(() => types.recordRel(S, bad), bad).toThrow(/TEAM_RECORD_PATH|not a record path|names no folder/);
  });

  it("leave an archived type's folder out, as the column does", () => {
    const { types } = setup();
    types.create({ spaceId: S, preset: "creator" });
    const lead = types.create({ spaceId: S, preset: "lead" });
    types.archive(lead.id);
    expect(types.folders(S)).toEqual(["creators"]);
    expect(types.recordRel(S, "nathan")).toBe("creators/nathan.md");
    expect(() => types.recordRel(S, "leads/acme")).toThrow(/not a record path/);
  });
});

describe("the person's edits to a type", () => {
  it("make a type from a preset or written out, each key and folder once, and log it", () => {
    const { types, lines, changed } = setup();
    const c = types.create({ spaceId: S, preset: "creator" });
    expect(c).toMatchObject({ key: "creator", folder: "creators", preset: "creator", sections: CREATOR_PRESET.sections, count: 0 });
    const t = types.create({ spaceId: S, one: "Vendor", many: "Vendors", folder: "vendors", head: [{ key: "Contact" }], sections: [{ heading: "Orders", shape: "list", dated: true }] });
    expect(t).toMatchObject({ key: "vendor", glyph: "records", titleField: "#", statusField: null, preset: null });
    expect(() => types.create({ spaceId: S, preset: "creator" })).toThrow(/already keeps a kind called creator/);
    expect(() => types.create({ spaceId: S, one: "Other", many: "Others", folder: "vendors" })).toThrow(/already Vendors's folder/);
    expect(lines.map((l) => [l.verb, l.object])).toEqual([["made_record_type", "Creators"], ["made_record_type", "Vendors"]]);
    expect(changed).toEqual([S, S]);
  });

  it("refuse a title field the head does not have, and a section or field named twice", () => {
    const { types } = setup();
    expect(() => types.create({ spaceId: S, one: "R", many: "Rs", folder: "rs", titleField: "Version" })).toThrow(/neither/);
    expect(() => types.create({ spaceId: S, one: "R", many: "Rs", folder: "rs", sections: [{ heading: "Notes", shape: "text" }, { heading: "notes", shape: "list" }] })).toThrow(/two sections/);
    expect(() => types.create({ spaceId: S, one: "R", many: "Rs", folder: "rs", head: [{ key: "A" }, { key: "a" }] })).toThrow(/two head fields/);
  });

  it("never moves a folder that holds records out from under them — and moves an empty one", () => {
    const { types, file } = setup();
    const lead = types.create({ spaceId: S, preset: "lead" });
    expect(types.update({ id: lead.id, folder: "prospects" }).folder).toBe("prospects");
    file("prospects/acme.md");
    // THE mutant: a rename that checks nothing, so a review's record_path points at a file that moved.
    expect(() => types.update({ id: lead.id, folder: "leads" })).toThrow(/holds 1 record, so its folder stays/);
    expect(types.update({ id: lead.id, one: "Prospect", many: "Prospects", sections: [{ heading: "Notes", shape: "text" }] })).toMatchObject({ folder: "prospects", many: "Prospects", count: 1 });
  });

  it("never changes a key: tools name it", () => {
    const { types } = setup();
    const lead = types.create({ spaceId: S, preset: "lead" });
    expect(() => types.update({ id: lead.id, key: "prospect" } as never)).toThrow();
  });

  it("archive hides a type and leaves its files; bringing it back shows them again", () => {
    const { types, file } = setup();
    const lead = types.create({ spaceId: S, preset: "lead" });
    file("leads/acme.md");
    types.archive(lead.id);
    expect(types.list(S)).toEqual([]);
    expect(types.views(S, true)[0]).toMatchObject({ archived: true, count: 1 });
    expect(types.archive(lead.id, false)).toMatchObject({ archived: false, count: 1 });
  });
});

describe("presets made once", () => {
  it("answer the type a team already has, and refuse to revive an archived one behind the person's back", () => {
    const { types, lines } = setup();
    const a = types.ensurePreset(S, "creator", "realm", "folder");
    expect(types.ensurePreset(S, "creator", "realm", "folder").id).toBe(a.id);
    expect(lines.filter((l) => l.verb === "adopted_record_type")).toHaveLength(1);
    types.archive(a.id);
    expect(() => types.ensurePreset(S, "creator", "user", "first-record")).toThrow(/archived/);
  });

  it("name an adopted folder's type apart from a key already taken", () => {
    const { types } = setup();
    types.create({ spaceId: S, one: "Lead", many: "Leads", folder: "prospects" });
    const t = types.adoptFolder(S, "leads", { head: [], sections: [], statusField: null, statuses: [] })!;
    expect([t.key, t.folder]).toEqual(["lead-2", "leads"]);
    expect(types.adoptFolder(S, "leads", { head: [], sections: [], statusField: null, statuses: [] })).toBeNull();
  });
});

describe("the reconcile's eye for a folder of records", () => {
  it("takes a folder whose files are records, and leaves notes, templates alone and empty folders", () => {
    const { repo, file } = setup();
    file("leads/acme.md", "# Acme\n- Status: new\n\n## Notes\n- big\n");
    file("leads/_template.md", "# Name\n");
    file("notes/one.md", "Just some words.\n");
    file("notes/two.md", "# Title only\n");
    file("titles/a.md", "# A\n");
    mkdirSync(join(repo, "empty"));
    expect(recordsIn(join(repo, "leads"))).toHaveLength(1);
    expect(recordsIn(join(repo, "notes"))).toBeNull();
    // A folder of bare titles is not a kind of record: nothing a record has beyond its name.
    expect(recordsIn(join(repo, "titles"))).toBeNull();
    expect(recordsIn(join(repo, "empty"))).toBeNull();
  });

  it("adopts only for a team, and makes the team's meta row if it has none", () => {
    const { db, repo, store, types, file } = setup();
    file("leads/acme.md", "# Acme\n- Status: new\n");
    file("imported/x.md", "# X\n- Status: new\n");
    file(".hidden/x.md", "# X\n- Status: new\n");
    const run = (ids: string[]) => adoptRecordTypes({ teamSpaceIds: () => ids, repoPath: () => repo, store, types });
    expect(run([])).toEqual([]);
    expect(run([S])).toEqual([{ spaceId: S, folder: "leads", key: "lead" }]);
    expect(db.prepare("SELECT template FROM team_meta WHERE space_id = ?").get(S)).toEqual({ template: null });
    expect(types.list(S).map((t) => t.folder)).toEqual(["leads"]);
    expect(recordPreset("lead")).not.toBeNull();
  });
});
