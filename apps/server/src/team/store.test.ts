import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { TeamStore } from "./store";

describe("the team activity log", () => {
  it("is append-only: nothing in the team code updates or deletes a line", () => {
    /* THE mutant: a "tidy the log" helper — an UPDATE that rewrites what a role did, or a DELETE that
       drops it. The log is the trust story (the Teams plan, section 11), so the source is read. */
    const here = fileURLToPath(new URL(".", import.meta.url));
    for (const f of ["store.ts", "service.ts", "agent-tools.ts"]) {
      const src = readFileSync(join(here, f), "utf8");
      expect(src, f).not.toMatch(/UPDATE\s+team_activity/i);
      expect(src, f).not.toMatch(/DELETE\s+FROM\s+team_activity/i);
    }
  });

  it("reads a space's lines newest first, and only that space's", () => {
    const db = openDatabase(join(tempDir("realm-team-store-"), "realm.db"));
    db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES ('p', 'P', 'x', '#000', 0, 1, 1)").run();
    for (const id of ["s1", "s2"]) db.prepare("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at) VALUES (?, 'p', ?, 'f', 0, '/tmp', 1, 1)").run(id, id);
    let t = 100;
    const store = new TeamStore(db, () => t++);
    store.appendActivity({ spaceId: "s1", actor: "user", verb: "approved", object: "a" });
    store.appendActivity({ spaceId: "s2", actor: "user", verb: "approved", object: "b" });
    store.appendActivity({ spaceId: "s1", actor: "realm", verb: "paused", object: "c" });
    expect(store.activity("s1", 10).map((a) => a.object)).toEqual(["c", "a"]);
    expect(store.activity("s1", 10, 102).map((a) => a.object)).toEqual(["a"]);
    db.close();
  });

  it("keeps lines written in the same millisecond in the order they were written", () => {
    const db = openDatabase(join(tempDir("realm-team-store-"), "realm.db"));
    db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES ('p', 'P', 'x', '#000', 0, 1, 1)").run();
    db.prepare("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at) VALUES ('s1', 'p', 's1', 'f', 0, '/tmp', 1, 1)").run();
    const store = new TeamStore(db, () => 500);
    // Making a team writes its roles and then "made this space a team", all in one millisecond.
    const objects = ["Creator Manager", "Content Producer", "Podcast Booker", "Editor", "Ops", "Researcher", "the team"];
    for (const o of objects) store.appendActivity({ spaceId: "s1", actor: "user", verb: "made_role", object: o, runId: "r1" });
    // THE MUTANT: tie-break on the id — a ULID's random tail shuffles lines that share a millisecond.
    expect(store.activity("s1", 20).map((a) => a.object)).toEqual([...objects].reverse());
    expect(store.activityForRun("r1").map((a) => a.object)).toEqual(objects);
    db.close();
  });
});
