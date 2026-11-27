import { describe, expect, it } from "vitest";
import { statSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { SessionEventSchema, sessionEvent, type SessionEvent } from "@realm/contracts";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "./profiles";
import { SpacesStore } from "./spaces";
import { EnvironmentsStore } from "./environments";
import { SessionsStore, SessionEventsStore } from "./sessions";
import { SettingsStore } from "./settings";
import { decodePayload } from "./event-payload";
import {
  EVENT_RETENTION_DAYS_KEY, EventRetention, RECLAIM_MIN_BYTES, TRIM_HEAD, TRIM_OVER, TRIM_TAIL,
  reclaimDecision, retentionDays, trimPayload, trimText,
} from "./event-retention";

const DAY = 86_400_000;
const NOW = 400 * DAY;
const long = (n: number, word = "line") => Array.from({ length: n }, (_, i) => `${word} ${i} of a long tool output`).join("\n");

function home() {
  const dir = tempDir("realm-retention-");
  const path = join(dir, "realm.db");
  const db = openDatabase(path);
  const profile = new ProfilesStore(db).create({ name: "W", icon: "x", color: "#000" });
  const space = new SpacesStore(db, dir).create({ profileId: profile.id, name: "S", icon: "f" });
  const env = new EnvironmentsStore(db).ensurePrimary(space.id);
  const sessions = new SessionsStore(db);
  const events = new SessionEventsStore(db);
  const settings = new SettingsStore(db);
  /** A session last active `daysAgo` days before NOW, with a long tool call, its long result and a long message. */
  const session = (title: string, daysAgo: number, o: { status?: string; pinned?: boolean; teammateHome?: boolean } = {}) => {
    const s = sessions.create({ spaceId: space.id, projectId: null, agentKind: "fake", model: null, effort: null, permissionMode: "default", environmentId: env.id, title });
    const at = NOW - daysAgo * DAY;
    events.append(s.id, sessionEvent("user_message", { text: long(200, "asked"), attachments: [] }, at));
    events.append(s.id, sessionEvent("tool_call", { toolUseId: "t1", name: "Bash", input: { command: "ls", description: long(200, "why") }, parentToolUseId: null }, at));
    events.append(s.id, sessionEvent("tool_result", { toolUseId: "t1", content: long(400, "out"), isError: false }, at));
    events.append(s.id, sessionEvent("assistant_text", { text: long(200, "said"), messageId: "m1" }, at));
    db.prepare("UPDATE sessions SET activity_at = ?, created_at = ?, status = ?, teammate_home = ?, provider_session_id = ? WHERE id = ?")
      .run(at, at, o.status ?? "idle", o.teammateHome ? 1 : 0, `cli-${title}`, s.id);
    if (o.pinned) {
      db.prepare("INSERT INTO items (id, space_id, kind, title, sort_order, pinned, ref_id, created_at, updated_at) VALUES (?, ?, 'session', ?, 0, 1, ?, 0, 0)")
        .run(`item-${s.id}`, space.id, title, s.id);
    }
    return s.id;
  };
  return { dir, path, db, sessions, events, settings, session };
}

const retention = (h: ReturnType<typeof home>, o: Partial<ConstructorParameters<typeof EventRetention>[0]> = {}) => new EventRetention({
  db: h.db, dbPath: h.path, settings: h.settings, busy: () => false, freeDiskBytes: () => 1e12, now: () => NOW,
  pauseMs: 0, busyPauseMs: 1, log: () => {}, ...o,
});

const rawPayloads = (db: Db, sessionId: string) => (db.prepare("SELECT type, payload_json FROM session_events WHERE session_id = ? ORDER BY seq").all(sessionId) as { type: string; payload_json: string | Uint8Array }[])
  .map((r) => ({ type: r.type, text: decodePayload(r.payload_json) }));
const resultOf = (db: Db, sessionId: string) => JSON.parse(rawPayloads(db, sessionId).find((r) => r.type === "tool_result")!.text) as { content: string };
const isTrimmed = (db: Db, sessionId: string) => resultOf(db, sessionId).content.length < TRIM_OVER;

describe("trimming a payload", () => {
  it("keeps a string up to TRIM_OVER whole, and cuts a longer one to its head, a note of what was cut, and its tail", () => {
    const short = "x".repeat(TRIM_OVER);
    expect(trimText(short)).toBe(short);
    const s = long(400);
    const cut = trimText(s);
    expect(cut.startsWith(s.slice(0, TRIM_HEAD))).toBe(true);
    expect(cut.endsWith(s.slice(-TRIM_TAIL))).toBe(true);
    expect(cut).toContain(`${(s.length - TRIM_HEAD - TRIM_TAIL).toLocaleString("en-US")} characters trimmed`);
    expect(trimText(cut)).toBe(cut);
  });

  it("cuts a tool result's content and the long strings anywhere in a tool call's input, and nothing else", () => {
    const result = trimPayload("tool_result", { toolUseId: "t", content: long(400), isError: true }) as Record<string, unknown>;
    expect(result).toMatchObject({ toolUseId: "t", isError: true });
    expect((result.content as string).length).toBeLessThan(TRIM_OVER);
    const call = trimPayload("tool_call", { toolUseId: "t", name: "Edit", input: { file_path: "/a.ts", edits: [{ old_string: long(300), new_string: "y" }] }, parentToolUseId: null }) as { input: { file_path: string; edits: { old_string: string; new_string: string }[] } };
    expect(call.input.file_path).toBe("/a.ts");
    expect(call.input.edits[0]!.new_string).toBe("y");
    expect(call.input.edits[0]!.old_string.length).toBeLessThan(TRIM_OVER);
    expect(trimPayload("tool_result", { toolUseId: "t", content: "short", isError: false })).toBeNull();
    expect(trimPayload("assistant_text", { text: long(400) })).toBeNull();
    expect(trimPayload("tool_call", { toolUseId: "t", name: "ExitPlanMode", input: { plan: long(400) }, parentToolUseId: null })).toBeNull();
  });
});

describe("the retention rule", () => {
  it("trims the tool payloads of a session idle past the window, and keeps its messages whole", () => {
    const h = home();
    const old = h.session("old", 31);
    const before = rawPayloads(h.db, old);
    expect(retention(h).step()).toMatchObject({ trimmed: 2, finished: false });
    const after = rawPayloads(h.db, old);
    expect(after.map((r) => r.type)).toEqual(before.map((r) => r.type));
    for (const type of ["user_message", "assistant_text"]) expect(after.find((r) => r.type === type)).toEqual(before.find((r) => r.type === type));
    expect(isTrimmed(h.db, old)).toBe(true);
    expect(JSON.parse(after[1]!.text)).toMatchObject({ name: "Bash", input: { command: "ls" } });
  });

  it("counts the window from the session's last activity: a day inside it is kept, a day past it is trimmed", () => {
    const h = home();
    const inside = h.session("inside", 29);
    const past = h.session("past", 31);
    h.settings.set(EVENT_RETENTION_DAYS_KEY, 30);
    const r = retention(h);
    while (!r.step().finished) { /* every cold session */ }
    expect(isTrimmed(h.db, inside)).toBe(false);
    expect(isTrimmed(h.db, past)).toBe(true);
  });

  it("keeps whole every session the person can still be working in: running, waiting on them, pinned, or a teammate's home chat", () => {
    const h = home();
    const kept = [
      h.session("running", 90, { status: "running" }),
      h.session("waiting", 90, { status: "waiting_permission" }),
      h.session("pinned", 90, { pinned: true }),
      h.session("teammate", 90, { teammateHome: true }),
    ];
    const ended = h.session("ended", 90, { status: "ended" });
    const r = retention(h);
    while (!r.step().finished) { /* every cold session */ }
    for (const id of kept) expect(isTrimmed(h.db, id)).toBe(false);
    expect(isTrimmed(h.db, ended)).toBe(true);
  });

  it("reads each event once: a second pass finds nothing, and a session that wakes and goes quiet again is read from its cursor", async () => {
    const h = home();
    const old = h.session("old", 60);
    const r = retention(h);
    expect((await r.prune()).trimmed).toBe(2);
    expect(r.step()).toMatchObject({ trimmed: 0, finished: true });
    h.events.append(old, sessionEvent("tool_result", { toolUseId: "t2", content: long(400, "later"), isError: false }, NOW - 40 * DAY));
    expect((await r.prune()).trimmed).toBe(1);
    expect((h.db.prepare("SELECT through_seq FROM event_retention WHERE session_id = ?").get(old) as { through_seq: number }).through_seq)
      .toBe((h.db.prepare("SELECT MAX(seq) AS m FROM session_events").get() as { m: number }).m);
  });

  it("takes its window from the setting, and 0 keeps every payload whole and never vacuums, as before retention", async () => {
    expect(retentionDays(null)).toBe(30);
    expect(retentionDays("7")).toBe(30);
    expect(retentionDays(90)).toBe(90);
    const h = home();
    const sixty = h.session("sixty", 60);
    h.settings.set(EVENT_RETENTION_DAYS_KEY, 90);
    await retention(h).run();
    expect(isTrimmed(h.db, sixty)).toBe(false);
    h.settings.set(EVENT_RETENTION_DAYS_KEY, 0);
    let asked = 0;
    await retention(h, { now: () => NOW + 1000 * DAY, freeDiskBytes: () => { asked++; return 1e12; } }).run();
    expect(isTrimmed(h.db, sixty)).toBe(false);
    expect(asked).toBe(0);
  });

  it("waits while an agent is working", async () => {
    const h = home();
    const old = h.session("old", 60);
    let working = true;
    const done = retention(h, { busy: () => working }).prune();
    await new Promise((r) => setTimeout(r, 20));
    expect(isTrimmed(h.db, old)).toBe(false);
    working = false;
    await done;
    expect(isTrimmed(h.db, old)).toBe(true);
  });
});

describe("a trimmed session's transcript", () => {
  it("still opens with every event, each parsing as the transcript reads it, and resumes as it did", async () => {
    const h = home();
    const old = h.session("old", 60);
    const before = h.events.listAfter(old, 0, 1000);
    const handover = h.events.transcript(old, Infinity);
    const row = h.sessions.get(old);
    await retention(h).prune();
    const after = h.events.listAfter(old, 0, 1000);
    expect(after.map((e) => [e.seq, e.event.type])).toEqual(before.map((e) => [e.seq, e.event.type]));
    for (const e of after) expect(SessionEventSchema.safeParse(e.event).success).toBe(true);
    const result = after.find((e) => e.event.type === "tool_result")!.event as Extract<SessionEvent, { type: "tool_result" }>;
    expect(result.payload.content).toContain("characters trimmed");
    expect(h.events.transcript(old, Infinity)).toEqual(handover);
    expect(h.sessions.get(old)).toEqual(row);
    expect(h.db.prepare("SELECT tool FROM event_tool_names tn JOIN session_events e ON e.seq = tn.seq WHERE e.session_id = ?").all(old)).toEqual([{ tool: "Bash" }]);
  });
});

describe("reclaiming free pages", () => {
  const enough = { freelistBytes: RECLAIM_MIN_BYTES, freedBytes: 0, fileBytes: 1e9, freeDiskBytes: 2e9, busy: false };

  it("runs only with enough to reclaim, no agent working, and twice the database's size free on disk", () => {
    expect(reclaimDecision(enough)).toEqual({ run: true });
    expect(reclaimDecision({ ...enough, freelistBytes: RECLAIM_MIN_BYTES - 1 }).run).toBe(false);
    expect(reclaimDecision({ ...enough, freelistBytes: RECLAIM_MIN_BYTES / 2, freedBytes: RECLAIM_MIN_BYTES / 2 }).run).toBe(true);
    expect(reclaimDecision({ ...enough, busy: true }).run).toBe(false);
    expect(reclaimDecision({ ...enough, freeDiskBytes: 2e9 - 1 })).toEqual({ run: false, reason: "2000.0 MB free on disk, needs 2000.0 MB" });
    expect(reclaimDecision({ ...enough, freeDiskBytes: null }).run).toBe(false);
  });

  /** A database with `mb` MB of free pages: rows written, then deleted. */
  function withFreePages(mb: number) {
    const h = home();
    const id = h.session("bulk", 1);
    const put = h.db.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (?, 0, 'status', ?)");
    for (let i = 0; i < mb * 16; i++) put.run(id, `${i}`.padEnd(64 * 1024, "x"));
    h.db.prepare("DELETE FROM session_events WHERE type = 'status'").run();
    h.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
    return h;
  }
  const size = (p: string) => statSync(p).size;

  it("vacuums the free pages away and logs what it reclaimed", () => {
    const h = withFreePages(4);
    const logged: string[] = [];
    const r = retention(h, { reclaimMinBytes: 1024 * 1024, log: (l) => logged.push(l) });
    const done = r.reclaim();
    expect(done.ran).toBe(true);
    expect(done.after).toBeLessThan(done.before - 3e6);
    expect(size(h.path)).toBe(done.after);
    expect(logged.at(-1)).toMatch(/^\[db\] vacuum: .* MB reclaimed in/);
    expect(r.reclaim()).toMatchObject({ ran: false });
  });

  it("counts what a prune freed inside pages still in use, which only a VACUUM gives back", async () => {
    const h = home();
    for (let i = 0; i < 40; i++) h.session(`old${i}`, 60);
    h.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
    const deps = { db: h.db, dbPath: h.path, settings: h.settings, busy: () => false, freeDiskBytes: () => 1e12, now: () => NOW, pauseMs: 0, log: () => {}, reclaimMinBytes: Infinity };
    const r = new EventRetention(deps);
    const pruned = await r.prune();
    // Just above the free pages alone: only the bytes trimmed inside pages still in use tip it over.
    const min = (h.db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count * 4096 + 1;
    deps.reclaimMinBytes = min;
    expect(pruned.bytesBefore - pruned.bytesAfter).toBeGreaterThan(1);
    expect(retention(h, { reclaimMinBytes: min }).reclaim()).toMatchObject({ ran: false, reason: expect.stringContaining("to reclaim") });
    expect(r.reclaim()).toMatchObject({ ran: true });
  });

  it("leaves the file alone when the disk cannot hold a second copy, and when an agent is working", () => {
    const h = withFreePages(4);
    const before = size(h.path);
    const tight = retention(h, { reclaimMinBytes: 1024 * 1024, freeDiskBytes: () => before });
    expect(tight.reclaim()).toMatchObject({ ran: false, reason: expect.stringContaining("free on disk") });
    const busy = retention(h, { reclaimMinBytes: 1024 * 1024, busy: () => true });
    expect(busy.reclaim()).toMatchObject({ ran: false, reason: "an agent is working" });
    expect(size(h.path)).toBe(before);
  });
});
