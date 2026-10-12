import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempDir } from "@realm/test-utils";
import { sessionEvent, type SessionEvent } from "@realm/contracts";
import { openDatabase, type Db } from "../db/database";
import { migrations } from "../db/migrations";
import { ProfilesStore } from "./profiles";
import { SpacesStore } from "./spaces";
import { EnvironmentsStore } from "./environments";
import { SessionsStore, SessionEventsStore } from "./sessions";
import { COMPRESS_MIN_BYTES, decodePayload, encodePayload, parsePayload, payloadSql } from "./event-payload";
import { COMPACTION_BATCH_BYTES, COMPACTION_SEQ_WINDOW, PayloadCompactor } from "./payload-compaction";
import { blobCount, deflateEveryPayload } from "./event-payload.test-fakes";

/** A tool's page dump: long and repetitive, like the rows that fill a real log. */
const page = (n: number, word = "row") => Array.from({ length: n }, (_, i) => `<li class="item">${word} ${i} of the listing</li>`).join("\n");

function fresh() {
  const home = tempDir("realm-payload-");
  const path = join(home, "realm.db");
  const db = openDatabase(path);
  const p = new ProfilesStore(db).create({ name: "W", icon: "x", color: "#000" });
  const space = new SpacesStore(db, home).create({ profileId: p.id, name: "S", icon: "f" });
  const env = new EnvironmentsStore(db).ensurePrimary(space.id);
  const session = new SessionsStore(db).create({ spaceId: space.id, projectId: null, agentKind: "fake", model: null, effort: null, permissionMode: "default", environmentId: env.id, title: "S" });
  return { db, path, space, session, events: new SessionEventsStore(db) };
}

/** A row as a build before v56 wrote it: the JSON text, whatever its size. */
const writePlain = (db: Db, sessionId: string, event: SessionEvent): number =>
  Number(db.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (?, ?, ?, ?)")
    .run(sessionId, event.ts, event.type, JSON.stringify(event.payload)).lastInsertRowid);

const stored = (db: Db, seq: number) => db.prepare("SELECT typeof(payload_json) AS t, payload_json AS v FROM session_events WHERE seq = ?").get(seq) as { t: string; v: string | Uint8Array };

describe("event payload codec", () => {
  it("keeps a short payload as its text, and compresses a long one into a codec byte and deflate", () => {
    const short = JSON.stringify({ status: "running" });
    expect(encodePayload(short)).toBe(short);
    const long = JSON.stringify({ toolUseId: "t", content: page(200), isError: false });
    const packed = encodePayload(long);
    expect(packed).toBeInstanceOf(Uint8Array);
    expect((packed as Uint8Array)[0]).toBe(1);
    expect((packed as Uint8Array).byteLength).toBeLessThan(long.length / 4);
    expect(decodePayload(packed)).toBe(long);
  });

  it("round-trips text exactly: multibyte characters, escapes, and the threshold's edge", () => {
    for (const text of ["é".repeat(COMPRESS_MIN_BYTES), "😀 ".repeat(400), `${"a".repeat(COMPRESS_MIN_BYTES - 12)}\\n\\"`, "\u0000".repeat(700)]) {
      const json = JSON.stringify({ text });
      expect(decodePayload(encodePayload(json))).toBe(json);
    }
    const under = JSON.stringify({ t: "x".repeat(COMPRESS_MIN_BYTES - 10) });
    expect(Buffer.byteLength(under)).toBeLessThan(COMPRESS_MIN_BYTES);
    expect(encodePayload(under)).toBe(under);
  });

  it("refuses a codec it does not know rather than guessing", () => {
    expect(() => decodePayload(new Uint8Array([9, 1, 2]))).toThrow(/codec 9/);
    expect(parsePayload(new Uint8Array([9, 1, 2]))).toBeUndefined();
  });

  it("lets SQL read into a compressed row through the registered function", () => {
    const { db, session, events } = fresh();
    const big = events.append(session.id, sessionEvent("tool_call", { toolUseId: "t", name: "Skill", input: { skill: "deploy", notes: page(80) }, parentToolUseId: null }, 5));
    expect(stored(db, big.seq).t).toBe("blob");
    expect(db.prepare(`SELECT json_extract(${payloadSql("payload_json")}, '$.input.skill') AS s FROM session_events WHERE seq = ?`).get(big.seq)).toEqual({ s: "deploy" });
  });
});

describe("SessionEventsStore over compressed payloads", () => {
  it("writes a long event compressed and a short one as text, and reads both back as they were", () => {
    const { db, session, events } = fresh();
    const result = sessionEvent("tool_result", { toolUseId: "t1", content: page(300), isError: false }, 10);
    const a = events.append(session.id, sessionEvent("status", { status: "running" }, 9));
    const b = events.append(session.id, result);
    expect(stored(db, a.seq).t).toBe("text");
    expect(stored(db, b.seq).t).toBe("blob");
    expect(events.listAfter(session.id, 0, 10).map((e) => e.event)).toEqual([sessionEvent("status", { status: "running" }, 9), result]);
  });

  it("reads a log that mixes pre-v56 text rows with compressed ones, through every reader", () => {
    const { db, session, events, space } = fresh();
    const longAsk = `Look at this:\n${page(60, "ask")}`;
    const longReply = `Done.\n${page(60, "reply")}`;
    const ask = writePlain(db, session.id, sessionEvent("user_message", { text: longAsk, attachments: [] }, 10));
    events.append(session.id, sessionEvent("permission_request", { requestId: "r1", toolName: "Bash", input: { command: page(40) }, title: "Run", suggestions: [] }, 11));
    writePlain(db, session.id, sessionEvent("permission_request", { requestId: "r2", toolName: "Bash", input: {}, title: "Run", suggestions: [] }, 12));
    events.append(session.id, sessionEvent("assistant_text", { messageId: "m", text: longReply }, 13));
    expect(blobCount(db)).toBe(2);

    expect(events.listAfter(session.id, 0, 10).map((e) => e.event.type)).toEqual(["user_message", "permission_request", "permission_request", "assistant_text"]);
    expect(events.listOfTypes(session.id, ["user_message", "assistant_text"], { limit: 10 }).map((e) => e.seq)).toContain(ask);
    expect(events.findDanglingPermissions(session.id)).toEqual(["r1", "r2"]);
    expect((events.lastOfType(session.id, "assistant_text")?.payload as { text: string }).text).toBe(longReply);
    expect(events.lastOfTypes(session.id, ["permission_request"])?.payload).toMatchObject({ requestId: "r2" });
    expect(events.transcript(session.id, 100)).toEqual([{ role: "user", text: longAsk }, { role: "assistant", text: longReply }]);
    expect(events.lastReplies(space.id)).toEqual([{ sessionId: session.id, lastReply: "Done." }]);

    // …and once the rest are compressed too, every reader still says the same.
    deflateEveryPayload(db);
    expect(events.findDanglingPermissions(session.id)).toEqual(["r1", "r2"]);
    expect(events.transcript(session.id, 100)).toEqual([{ role: "user", text: longAsk }, { role: "assistant", text: longReply }]);
    expect(events.lastReplies(space.id)).toEqual([{ sessionId: session.id, lastReply: "Done." }]);
    expect(events.lastOfTypes(session.id, ["permission_request"])?.payload).toMatchObject({ requestId: "r2" });
    expect(events.listAfter(session.id, 0, 10)).toHaveLength(4);
  });

  it("keeps search indexing the words, not the stored bytes", () => {
    const { db, session, events } = fresh();
    const r = events.append(session.id, sessionEvent("assistant_text", { messageId: "m", text: `zanzibar ${page(50)}` }, 1));
    expect(stored(db, r.seq).t).toBe("blob");
    expect(db.prepare("SELECT seq FROM search_index WHERE search_index MATCH 'zanzibar'").all()).toEqual([{ seq: r.seq }]);
  });
});

describe("PayloadCompactor", () => {
  /** A pre-v56 log: `n` long tool results and short statuses between them, all stored as text. */
  function oldLog(n: number) {
    const f = fresh();
    const texts = new Map<number, string>();
    for (let i = 0; i < n; i++) {
      const seq = writePlain(f.db, f.session.id, sessionEvent("tool_result", { toolUseId: `t${i}`, content: page(40 + i, `r${i}`), isError: false }, i));
      texts.set(seq, JSON.stringify({ toolUseId: `t${i}`, content: page(40 + i, `r${i}`), isError: false }));
      const s = writePlain(f.db, f.session.id, sessionEvent("status", { status: "idle" }, i));
      texts.set(s, JSON.stringify({ status: "idle" }));
    }
    return { ...f, texts };
  }
  const textsNow = (db: Db) => new Map((db.prepare("SELECT seq, payload_json FROM session_events").all() as { seq: number; payload_json: string | Uint8Array }[])
    .map((r) => [r.seq, decodePayload(r.payload_json)]));
  const cursor = (db: Db) => (db.prepare("SELECT done FROM event_payload_compaction").get() as { done: number }).done;

  it("compresses every long text row, leaves the short ones, and changes no payload", async () => {
    const { db, texts } = oldLog(30);
    await new PayloadCompactor({ db, pauseMs: 0, log: () => {} }).run();
    expect(blobCount(db)).toBe(30);
    expect((db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE typeof(payload_json) = 'text'").get() as { n: number }).n).toBe(30);
    expect(textsNow(db)).toEqual(texts);
    expect(cursor(db)).toBe(60);
  });

  it("resumes where an interrupted run stopped, and a second run finds nothing to do", () => {
    const { db, path, texts } = oldLog(10);
    // The byte budget is what ends a batch here; four long rows are well under it, so shrink the log's
    // window instead by stepping with an end part-way through.
    const first = new PayloadCompactor({ db }).step(8);
    expect(first).toMatchObject({ compressed: 4, finished: true });
    expect(cursor(db)).toBe(8);
    db.close();
    // A crash, a relaunch: a new connection and a new compactor pick up from the cursor.
    const again = openDatabase(path);
    const second = new PayloadCompactor({ db: again }).step();
    expect(second).toMatchObject({ scanned: 6, compressed: 6, finished: true });
    expect(blobCount(again)).toBe(10);
    expect(textsNow(again)).toEqual(texts);
    expect(new PayloadCompactor({ db: again }).step()).toMatchObject({ scanned: 0, compressed: 0, finished: true });
  });

  it("is idempotent even when its cursor is lost: a rerun from zero skips rows already compressed", () => {
    const { db, texts, session } = oldLog(6);
    // One row whose compressed form is itself past the threshold, so only its storage class says "done".
    const noise = sessionEvent("tool_result", { toolUseId: "n", content: randomBytes(1500).toString("hex"), isError: false }, 99);
    const n = writePlain(db, session.id, noise);
    texts.set(n, JSON.stringify(noise.payload));
    new PayloadCompactor({ db }).step();
    expect((stored(db, n).v as Uint8Array).byteLength).toBeGreaterThan(COMPRESS_MIN_BYTES);
    db.prepare("UPDATE event_payload_compaction SET done = 0").run();
    expect(new PayloadCompactor({ db }).step()).toMatchObject({ scanned: 0, compressed: 0 });
    expect(textsNow(db)).toEqual(texts);
  });

  it("bounds a batch by its seq window and by its byte budget", () => {
    const { db, session } = fresh();
    for (let i = 0; i < COMPACTION_SEQ_WINDOW + 5; i++) writePlain(db, session.id, sessionEvent("status", { status: "idle" }, i));
    const big = writePlain(db, session.id, sessionEvent("tool_result", { toolUseId: "x", content: page(100), isError: false }, 1));
    const c = new PayloadCompactor({ db });
    expect(c.step()).toMatchObject({ scanned: 0, finished: false });
    expect(cursor(db)).toBe(COMPACTION_SEQ_WINDOW);
    expect(c.step()).toMatchObject({ scanned: 1, compressed: 1, finished: true });
    expect(stored(db, big).t).toBe("blob");

    const huge = fresh();
    const each = page(COMPACTION_BATCH_BYTES / 40 / 2);
    for (let i = 0; i < 4; i++) writePlain(huge.db, huge.session.id, sessionEvent("tool_result", { toolUseId: `h${i}`, content: each, isError: false }, i));
    const h = new PayloadCompactor({ db: huge.db });
    expect(h.step()).toMatchObject({ scanned: 2, finished: false });
    expect(h.step()).toMatchObject({ scanned: 2, finished: true });
  });

  it("stands aside while an agent works and stops when asked", async () => {
    const { db } = oldLog(4);
    let working = true;
    const c = new PayloadCompactor({ db, busy: () => working, busyPauseMs: 5, pauseMs: 0, log: () => {} });
    const run = c.run();
    await new Promise((r) => setTimeout(r, 30));
    expect(blobCount(db)).toBe(0);
    working = false;
    await run;
    expect(blobCount(db)).toBe(4);

    const second = oldLog(4);
    const stopped = new PayloadCompactor({ db: second.db, busy: () => true, busyPauseMs: 5 });
    const pending = stopped.run();
    stopped.stop();
    await pending;
    expect(blobCount(second.db)).toBe(0);
  });

  it("pauses on a home without its cursor table, and does nothing with no cursor row", () => {
    const { db } = oldLog(2);
    db.exec("DROP TABLE event_payload_compaction");
    expect(() => new PayloadCompactor({ db }).step()).toThrow();
    db.exec("CREATE TABLE event_payload_compaction (id INTEGER PRIMARY KEY CHECK (id = 1), done INTEGER NOT NULL)");
    expect(new PayloadCompactor({ db }).step()).toMatchObject({ scanned: 0, finished: true });
    expect(blobCount(db)).toBe(0);
  });
});

describe("migration v56 — compressed event payloads", () => {
  const V56_AT = migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS event_payload_compaction"));

  /** A home at the version before v56, by hand: only the tables v56 and the compactor touch. */
  function beforeV56(path: string) {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE session_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE INDEX session_events_session ON session_events(session_id, seq);`);
    for (let v = 1; v <= V56_AT; v++) db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(v, 1);
    const ins = db.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES ('s', ?, ?, ?)");
    ins.run(1, "status", JSON.stringify({ status: "idle" }));
    ins.run(2, "tool_result", JSON.stringify({ toolUseId: "t", content: page(100), isError: false }));
    ins.run(3, "assistant_text", JSON.stringify({ messageId: "m", text: "ok" }));
    db.close();
  }
  const rows = (db: DatabaseSync | Db) => db.prepare("SELECT seq, ts, type, typeof(payload_json) AS t, payload_json FROM session_events ORDER BY seq").all();

  it("is appended after v54, found by its text", () => {
    expect(V56_AT).toBeGreaterThanOrEqual(54);
    expect(migrations.findIndex((m) => m.includes("CREATE TABLE IF NOT EXISTS team_policies"))).toBeLessThan(V56_AT);
  });

  it("adds the cursor, rewrites no row, and is safe to meet twice", () => {
    const path = join(tempDir("realm-v56-"), "realm.db");
    beforeV56(path);
    const raw = new DatabaseSync(path);
    const was = rows(raw);
    raw.close();
    const db = openDatabase(path);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(migrations.length);
    expect(db.prepare("SELECT id, done FROM event_payload_compaction").all()).toEqual([{ id: 1, done: 0 }]);
    expect(rows(db)).toEqual(was);
    db.exec(migrations[V56_AT]!);
    expect(db.prepare("SELECT id, done FROM event_payload_compaction").all()).toEqual([{ id: 1, done: 0 }]);
    // …and the compactor then takes the old home's long row, and only it.
    expect(new PayloadCompactor({ db }).step()).toMatchObject({ compressed: 1, finished: true });
    expect((rows(db) as { t: string }[]).map((r) => r.t)).toEqual(["text", "blob", "text"]);
    db.close();
  });
});
