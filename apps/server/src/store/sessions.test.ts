import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { sessionEvent } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { ProfilesStore } from "./profiles";
import { SpacesStore } from "./spaces";
import { SessionsStore, SessionEventsStore } from "./sessions";
import { NotFoundError } from "./rows";

function fresh() {
  const home = mkdtempSync(join(tmpdir(), "realm-"));
  const db = openDatabase(join(home, "realm.db"));
  const p = new ProfilesStore(db).create({ name: "W", icon: "x", color: "#000" });
  const space = new SpacesStore(db, home).create({ profileId: p.id, name: "S", icon: "f" });
  return { db, home, space };
}
const input = (spaceId: string) => ({ spaceId, projectId: null, agentKind: "fake" as const, model: null, effort: null, permissionMode: "default", cwd: "/tmp", title: "New session" });

describe("SessionsStore + SessionEventsStore", () => {
  it("creates a session, appends events with increasing seq, lists after seq, updates status/lastEventSeq", () => {
    const { db, space } = fresh(); const s = new SessionsStore(db); const ev = new SessionEventsStore(db);
    const sess = s.create(input(space.id));
    expect(sess.status).toBe("idle"); expect(sess.lastEventSeq).toBe(0); expect(sess.providerSessionId).toBeNull();
    const a = ev.append(sess.id, sessionEvent("status", { status: "running" }));
    const b = ev.append(sess.id, sessionEvent("assistant_text", { messageId: "m", text: "hi" }));
    expect(b.seq).toBe(a.seq + 1);
    expect(ev.listAfter(sess.id, a.seq, 100).map((e) => e.seq)).toEqual([b.seq]);
    expect(ev.listAfter(sess.id, 0, 100).map((e) => e.event.type)).toEqual(["status", "assistant_text"]);
    expect(ev.listAfter(sess.id, 0, 1)).toHaveLength(1);
    s.update({ id: sess.id, status: "running", lastEventSeq: b.seq, providerSessionId: "p1" });
    expect(s.get(sess.id)?.status).toBe("running"); expect(s.get(sess.id)?.providerSessionId).toBe("p1");
    expect(s.get(sess.id)?.lastEventSeq).toBe(b.seq);
    expect(s.list(space.id).map((x) => x.id)).toEqual([sess.id]);
    expect(s.listAll()).toHaveLength(1);
  });
  it("update patches title/model/effort/permissionMode and delete cascades events", () => {
    const { db, space } = fresh(); const s = new SessionsStore(db); const ev = new SessionEventsStore(db);
    const sess = s.create(input(space.id));
    ev.append(sess.id, sessionEvent("status", { status: "running" }));
    const u = s.update({ id: sess.id, title: "hello", model: "m1", effort: "high", permissionMode: "plan" });
    expect(u).toMatchObject({ title: "hello", model: "m1", effort: "high", permissionMode: "plan" });
    expect(s.update({ id: sess.id, model: null }).model).toBeNull();
    s.delete(sess.id);
    expect(s.get(sess.id)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS c FROM session_events").get()).toEqual({ c: 0 });
    expect(() => s.delete(sess.id)).toThrow(NotFoundError);
    expect(() => s.update({ id: sess.id, title: "x" })).toThrow(NotFoundError);
  });
  it("skips stored events that no longer validate", () => {
    const { db, space } = fresh(); const s = new SessionsStore(db); const ev = new SessionEventsStore(db);
    const sess = s.create(input(space.id));
    db.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (?, ?, ?, ?)").run(sess.id, 1, "bogus", "{}");
    ev.append(sess.id, sessionEvent("error", { message: "e" }));
    expect(ev.listAfter(sess.id, 0, 10).map((e) => e.event.type)).toEqual(["error"]);
  });
  it("setLastEventSeq touches only the seq; findDanglingPermission reports the newest unanswered request", () => {
    const { db, space } = fresh(); const s = new SessionsStore(db); const ev = new SessionEventsStore(db);
    const sess = s.create(input(space.id));
    s.setLastEventSeq(sess.id, 42);
    expect(s.get(sess.id)).toMatchObject({ lastEventSeq: 42, status: "idle", title: "New session" });
    expect(ev.findDanglingPermission(sess.id)).toBeNull();
    const req = (id: string) => sessionEvent("permission_request", { requestId: id, toolName: "Bash", input: {}, title: "?", suggestions: [] });
    ev.append(sess.id, req("r1"));
    ev.append(sess.id, sessionEvent("permission_response", { requestId: "r1", decision: "allow" }));
    expect(ev.findDanglingPermission(sess.id)).toBeNull();
    ev.append(sess.id, req("r2"));
    expect(ev.findDanglingPermission(sess.id)).toBe("r2");
    expect(ev.hasType(sess.id, "permission_request")).toBe(true);
    expect(ev.hasType(sess.id, "usage")).toBe(false);
  });
  it("rejects a session for an unknown space", () => {
    const { db } = fresh();
    expect(() => new SessionsStore(db).create(input("01ARZ3NDEKTSV4RRFFQ69G5FAV"))).toThrow(NotFoundError);
  });
});
