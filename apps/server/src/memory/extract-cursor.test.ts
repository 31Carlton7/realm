import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../db/database";
import { LearnedCursors } from "./extract-cursor";

function home() {
  const db = openDatabase(join(tempDir("realm-db-"), "realm.db"));
  // The cursor alone: no space, environment or session row behind it. The cascade is the migration's
  // test (db/database.test.ts).
  db.exec("PRAGMA foreign_keys = OFF");
  return { db, cursors: new LearnedCursors(db) };
}

describe("LearnedCursors", () => {
  it("has nothing for a session never read", () => {
    expect(home().cursors.get("s1")).toBeNull();
  });

  it("never moves backwards — a pass that finishes late must not hand the next one text already read", () => {
    const { cursors } = home();
    cursors.advance("s1", 40, false, 1);
    cursors.advance("s1", 25, false, 2);
    expect(cursors.get("s1")).toEqual({ throughSeq: 40, agentSaved: false });
  });

  it("remembers that the agent saved, once it has", () => {
    const { cursors } = home();
    cursors.advance("s1", 10, true, 1);
    cursors.advance("s1", 20, false, 2);
    expect(cursors.get("s1")).toEqual({ throughSeq: 20, agentSaved: true });
  });
});
