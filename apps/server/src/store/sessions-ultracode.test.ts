import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { ProfilesStore } from "./profiles";
import { SpacesStore } from "./spaces";
import { SessionsStore } from "./sessions";
import { EnvironmentsStore } from "./environments";

/**
 * A session's Ultracode request in the store: one `settings` row for each session that asked, which
 * the sessions store writes, reads and removes itself. It is no column, so nothing in the schema
 * ties the row to the session, and each of the three is held here on its own: the write returns a
 * session that already carries it, every read finds it, and a deleted session leaves none behind.
 */

function fresh() {
  const home = tempDir("realm-ultracode-store-");
  const db = openDatabase(join(home, "realm.db"));
  const profile = new ProfilesStore(db).create({ name: "W", icon: "x", color: "#000" });
  const space = new SpacesStore(db, home).create({ profileId: profile.id, name: "S", icon: "f" });
  const env = new EnvironmentsStore(db).ensurePrimary(space.id);
  const sessions = new SessionsStore(db);
  const create = () => sessions.create({ spaceId: space.id, projectId: null, agentKind: "claude", model: null, effort: null, permissionMode: "default", environmentId: env.id, title: "New session" });
  const kept = () => db.prepare("SELECT key, value_json FROM settings WHERE key LIKE 'sessions.ultracode:%' ORDER BY key").all();
  return { db, space, sessions, create, kept };
}

describe("a session's Ultracode request in the store", () => {
  it("is on the session the update that sets it returns", () => {
    const { sessions, create } = fresh();
    expect(sessions.update({ id: create().id, ultracode: true }).ultracode).toBe(true);
  });

  it("is kept as one settings row under the session's own key, holding true", () => {
    const { sessions, create, kept } = fresh();
    const { id } = create();
    sessions.update({ id, ultracode: true });
    expect(kept()).toEqual([{ key: `sessions.ultracode:${id}`, value_json: "true" }]);
  });

  it("is read back by get, by a space's list and by the list of every session", () => {
    const { space, sessions, create } = fresh();
    const { id } = create();
    sessions.update({ id, ultracode: true });
    expect([sessions.get(id)?.ultracode, sessions.list(space.id)[0]?.ultracode, sessions.listAll()[0]?.ultracode]).toEqual([true, true, true]);
  });

  it("stays one row for a session that is set to it twice", () => {
    const { sessions, create, kept } = fresh();
    const { id } = create();
    sessions.update({ id, ultracode: true });
    sessions.update({ id, ultracode: true });
    expect(kept()).toHaveLength(1);
  });

  it("is left as it is by an update that does not name it", () => {
    const { sessions, create } = fresh();
    const { id } = create();
    sessions.update({ id, ultracode: true });
    expect(sessions.update({ id, title: "renamed" }).ultracode).toBe(true);
  });

  it("is gone from the session the update that takes it back returns", () => {
    const { sessions, create } = fresh();
    const { id } = create();
    sessions.update({ id, ultracode: true });
    expect(sessions.update({ id, ultracode: false })).not.toHaveProperty("ultracode");
  });

  it("leaves no settings row behind when it is taken back", () => {
    const { sessions, create, kept } = fresh();
    const { id } = create();
    sessions.update({ id, ultracode: true });
    sessions.update({ id, ultracode: false });
    expect(kept()).toEqual([]);
  });

  it("writes no row for a session that is set to off without ever having asked", () => {
    const { sessions, create, kept } = fresh();
    sessions.update({ id: create().id, ultracode: false });
    expect(kept()).toEqual([]);
  });

  it("is absent from a session that never asked", () => {
    const { create } = fresh();
    expect(create()).not.toHaveProperty("ultracode");
  });

  it("is one session's own: another session in the same space does not read it", () => {
    const { sessions, create } = fresh();
    const asked = create();
    const other = create();
    sessions.update({ id: asked.id, ultracode: true });
    expect(sessions.get(other.id)).not.toHaveProperty("ultracode");
  });

  it("goes with the session when the session is deleted", () => {
    const { sessions, create, kept } = fresh();
    const { id } = create();
    sessions.update({ id, ultracode: true });
    sessions.delete(id);
    expect(kept()).toEqual([]);
  });

  it("leaves another session's row alone when one session is deleted", () => {
    const { sessions, create, kept } = fresh();
    const gone = create();
    const stays = create();
    sessions.update({ id: gone.id, ultracode: true });
    sessions.update({ id: stays.id, ultracode: true });
    sessions.delete(gone.id);
    expect(kept()).toEqual([{ key: `sessions.ultracode:${stays.id}`, value_json: "true" }]);
  });

  it("has its key spelled once in the store, so that the write, the removal and the read cannot come to differ", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "sessions.ts"), "utf8");
    expect(source.split("sessions.ultracode:")).toHaveLength(2);
  });

  it.each(["false", "null", '"true"', "1", "not json"])("reads a stored value of %s as a session that did not ask", (stored) => {
    const { db, sessions, create } = fresh();
    const { id } = create();
    db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?)").run(`sessions.ultracode:${id}`, stored);
    expect(sessions.get(id)).not.toHaveProperty("ultracode");
  });
});
