import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { SAVED_REPLY_MAX, sessionEvent } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { ProfilesStore } from "./profiles";
import { SpacesStore } from "./spaces";
import { SessionsStore, SessionEventsStore } from "./sessions";
import { EnvironmentsStore } from "./environments";
import { SavedTurnsStore } from "./saved-turns";

/** A home with two profiles, a space in each and a session in each space, and a log to save from. */
function fresh() {
  const home = tempDir("realm-");
  const db = openDatabase(join(home, "realm.db"));
  const profiles = new ProfilesStore(db), spaces = new SpacesStore(db, home), sessions = new SessionsStore(db);
  const events = new SessionEventsStore(db);
  const sessionIn = (profileName: string, title: string) => {
    const p = profiles.create({ name: profileName, icon: "x", color: "#000" });
    const space = spaces.create({ profileId: p.id, name: `${profileName} space`, icon: "f" });
    const env = new EnvironmentsStore(db).ensurePrimary(space.id);
    const s = sessions.create({ spaceId: space.id, projectId: null, agentKind: "fake", model: null, effort: null, permissionMode: "default", environmentId: env.id, title });
    return { profile: p, space, session: s };
  };
  const work = sessionIn("Work", "Org access");
  const home2 = sessionIn("Home", "Recipes");
  const ask = (sessionId: string, text: string, ts: number, extra: Record<string, unknown> = {}) =>
    events.append(sessionId, sessionEvent("user_message", { text, attachments: [], ...extra } as never, ts)).seq;
  const say = (sessionId: string, text: string, ts: number) => events.append(sessionId, sessionEvent("assistant_text", { messageId: `m${ts}`, text }, ts)).seq;
  return { dir: home, db, sessions, events, saved: new SavedTurnsStore(db), work, home: home2, ask, say };
}

describe("SavedTurnsStore", () => {
  it("keeps a saved prompt by its event, per session, in the log's order", () => {
    const { saved, work, ask, say } = fresh();
    const a = ask(work.session.id, "Fix the crash", 10);
    say(work.session.id, "Fixed.", 11);
    const b = ask(work.session.id, "Add a test", 20);
    expect(saved.set(work.session.id, b, true)).toEqual([b]);
    expect(saved.set(work.session.id, a, true)).toEqual([a, b]);
    expect(saved.forSession(work.session.id)).toEqual([a, b]);
  });

  it("survives a reopen of the same home — it is on disk, not in memory", () => {
    const { dir, db, saved, work, ask } = fresh();
    const a = ask(work.session.id, "Fix the crash", 10);
    saved.set(work.session.id, a, true);
    db.close();
    const again = openDatabase(join(dir, "realm.db"));
    expect(new SavedTurnsStore(again).forSession(work.session.id)).toEqual([a]);
    again.close();
  });

  it("unsaves, and saving or unsaving twice changes nothing", () => {
    const { db, saved, work, ask } = fresh();
    const a = ask(work.session.id, "Fix the crash", 10);
    saved.set(work.session.id, a, true);
    // Saved long ago: a second save is not a new one, so the turn keeps its place in the Library's list.
    db.prepare("UPDATE saved_turns SET saved_at = 5").run();
    saved.set(work.session.id, a, true);
    expect((db.prepare("SELECT COUNT(*) AS n, MIN(saved_at) AS at FROM saved_turns").get() as { n: number; at: number })).toEqual({ n: 1, at: 5 });
    expect(saved.set(work.session.id, a, false)).toEqual([]);
    expect(saved.set(work.session.id, a, false)).toEqual([]);
  });

  it("stores the event, never the words — what is listed is read back off the log", () => {
    const { db, saved, work, ask } = fresh();
    const a = ask(work.session.id, "Fix the crash in the membership check", 10);
    saved.set(work.session.id, a, true);
    const cols = (db.prepare("PRAGMA table_info(saved_turns)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["event_seq", "session_id", "saved_at"]);
    // Rewording the event (nothing in Realm does; the point is where the words come from) is what the
    // list then says.
    db.prepare("UPDATE session_events SET payload_json = ? WHERE seq = ?").run(JSON.stringify({ text: "Reworded", attachments: [] }), a);
    expect(saved.list(work.profile.id).entries.map((e) => e.text)).toEqual(["Reworded"]);
  });

  it("refuses anything but a prompt of that session", () => {
    const { saved, work, home, ask, say } = fresh();
    const answer = say(work.session.id, "Fixed.", 11);
    const theirs = ask(home.session.id, "Soup?", 12);
    expect(() => saved.set(work.session.id, answer, true)).toThrow(/not a prompt/);
    expect(() => saved.set(work.session.id, theirs, true)).toThrow(/not found/);
    expect(() => saved.set(work.session.id, 999_999, true)).toThrow(/not found/);
    expect(saved.forSession(work.session.id)).toEqual([]);
    expect(saved.forSession(home.session.id)).toEqual([]);
  });

  it("goes with its prompt: a rewind that cuts the event, and the session's deletion", () => {
    const { db, events, saved, work, ask } = fresh();
    const a = ask(work.session.id, "Keep this", 10);
    const b = ask(work.session.id, "Rewound away", 20);
    saved.set(work.session.id, a, true);
    saved.set(work.session.id, b, true);
    events.truncate(work.session.id, a);
    expect(saved.forSession(work.session.id)).toEqual([a]);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(work.session.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM saved_turns").get() as { n: number }).n).toBe(0);
  });

  it("lists a profile's saved turns across its sessions, newest saved first, with the answer each opened with", () => {
    const { db, saved, work, home, ask, say, sessions } = fresh();
    const other = sessions.create({ spaceId: work.space.id, projectId: null, agentKind: "fake", model: null, effort: null, permissionMode: "default",
      environmentId: work.session.environmentId, title: "Billing split" });
    const a = ask(work.session.id, "Fix the crash", 10);
    say(work.session.id, "Fixed — the check ran before the org loaded.", 11);
    say(work.session.id, "And a second message in the same turn.", 12);
    const b = ask(work.session.id, "Now nothing has answered this one", 20);
    ask(work.session.id, "A later prompt", 30);
    say(work.session.id, "An answer to the LATER prompt, not to b.", 31);
    const c = ask(other.id, "Split billing", 40, { attachments: [{ path: "/w/plan.md", mime: "text/markdown" }] });
    say(other.id, "x".repeat(SAVED_REPLY_MAX + 50), 41);
    const theirs = ask(home.session.id, "Soup?", 50);
    for (const [s, seq] of [[work.session.id, a], [work.session.id, b], [other.id, c], [home.session.id, theirs]] as const) saved.set(s, seq, true);
    // Saved in that order; the clock is the row's own, so stagger it.
    const stamp = db.prepare("UPDATE saved_turns SET saved_at = ? WHERE event_seq = ?");
    stamp.run(100, a); stamp.run(200, b); stamp.run(300, c); stamp.run(400, theirs);

    const { entries, total } = saved.list(work.profile.id);
    expect(total).toBe(3);
    expect(entries.map((e) => [e.seq, e.sessionTitle, e.text, e.reply?.slice(0, 20) ?? null])).toEqual([
      [c, "Billing split", "Split billing", "x".repeat(20)],
      [b, "Org access", "Now nothing has answered this one", null],
      [a, "Org access", "Fix the crash", "Fixed — the check ra"],
    ]);
    expect(entries[0]).toMatchObject({ sessionId: other.id, spaceId: work.space.id, ts: 40, savedAt: 300, attachments: ["/w/plan.md"], goal: null });
    expect(entries[0]!.reply).toHaveLength(SAVED_REPLY_MAX);
    // The other profile's list is its own.
    expect(saved.list(home.profile.id).entries.map((e) => e.seq)).toEqual([theirs]);
  });

  it("says how many there are when the list is cut", () => {
    const { saved, work, ask } = fresh();
    for (let i = 0; i < 5; i++) saved.set(work.session.id, ask(work.session.id, `p${i}`, 10 + i), true);
    const { entries, total } = saved.list(work.profile.id, 2);
    expect(entries).toHaveLength(2);
    expect(total).toBe(5);
  });
});
