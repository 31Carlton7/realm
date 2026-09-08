import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { artifactsFromEvent, sessionEvent } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { ProfilesStore } from "./profiles";
import { SpacesStore } from "./spaces";
import { SessionsStore, SessionEventsStore } from "./sessions";
import { EnvironmentsStore } from "./environments";
import { SettingsStore } from "./settings";
import { ArtifactsStore, ARTIFACTS_BACKFILL_KEY } from "./artifacts";

function fresh() {
  const home = tempDir("realm-");
  const db = openDatabase(join(home, "realm.db"));
  const settings = new SettingsStore(db);
  const p = new ProfilesStore(db).create({ name: "W", icon: "x", color: "#000" });
  const space = new SpacesStore(db, home).create({ profileId: p.id, name: "S", icon: "f" });
  const env = new EnvironmentsStore(db).ensurePrimary(space.id);
  const artifacts = new ArtifactsStore(db, settings);
  const sessions = new SessionsStore(db);
  const events = new SessionEventsStore(db, artifacts);
  const session = sessions.create({
    spaceId: space.id, projectId: null, agentKind: "fake", model: null, effort: null,
    permissionMode: "default", environmentId: env.id, title: "New session",
  });
  return { db, home, space, session, sessions, events, artifacts, settings };
}

const write = (path: string) => sessionEvent("tool_call", { toolUseId: `t${path}`, name: "Write", input: { file_path: path }, parentToolUseId: null });

describe("what counts as an artifact", () => {
  it("takes a written file off a tool_call and an attachment off a user_message, and nothing else", () => {
    const at = { sessionId: "s1", spaceId: "sp1", seq: 7, ts: 100 };
    expect(artifactsFromEvent({ ...at, type: "tool_call", payload: { name: "Write", input: { file_path: "/tmp/a/report.md" } } }))
      .toEqual([{ id: "s1:7:/tmp/a/report.md", sessionId: "s1", spaceId: "sp1", kind: "output", path: "/tmp/a/report.md", name: "report.md", ext: "md", ts: 100 }]);
    expect(artifactsFromEvent({ ...at, type: "user_message", payload: { text: "look", attachments: [{ path: "/tmp/shot.PNG", mime: "image/png" }] } }))
      .toEqual([{ id: "s1:7:/tmp/shot.PNG", sessionId: "s1", spaceId: "sp1", kind: "upload", path: "/tmp/shot.PNG", name: "shot.PNG", ext: "png", ts: 100 }]);
    // Every other event carries no file, and the extraction is TOTAL rather than a type switch at
    // the call site — the writer runs it on every append without knowing which types matter.
    expect(artifactsFromEvent({ ...at, type: "assistant_text", payload: { messageId: "m", text: "/tmp/a/report.md" } })).toEqual([]);
    expect(artifactsFromEvent({ ...at, type: "tool_call", payload: { name: "Bash", input: { command: "ls" } } })).toEqual([]);
    // A read is not a write, however file-shaped its input is.
    expect(artifactsFromEvent({ ...at, type: "tool_call", payload: { name: "Read", input: { file_path: "/tmp/a/report.md" } } })).toEqual([]);
  });

  it("unwraps an MCP tool name, so a Write reached through a server is still a Write", () => {
    const rows = artifactsFromEvent({
      sessionId: "s1", spaceId: "sp1", seq: 1, ts: 1, type: "tool_call",
      payload: { name: "mcp__files__Write", input: { path: "/tmp/x.md" } },
    });
    expect(rows.map((a) => a.path)).toEqual(["/tmp/x.md"]);
  });

  it("survives a payload that is not the shape it expects", () => {
    // These rows are replayed from disk by the backfill, where a payload written by an older build
    // is a normal thing to meet. Throwing here would stall the whole index on one bad row.
    const at = { sessionId: "s1", spaceId: "sp1", seq: 1, ts: 1 };
    expect(artifactsFromEvent({ ...at, type: "tool_call", payload: null })).toEqual([]);
    expect(artifactsFromEvent({ ...at, type: "tool_call", payload: { name: "Write" } })).toEqual([]);
    expect(artifactsFromEvent({ ...at, type: "user_message", payload: { attachments: "no" } })).toEqual([]);
    expect(artifactsFromEvent({ ...at, type: "user_message", payload: { attachments: [{ path: "  " }, {}] } })).toEqual([]);
  });
});

describe("ArtifactsStore", () => {
  it("indexes at the one choke point every persisted event passes through", () => {
    const { events, session, artifacts } = fresh();
    events.append(session.id, write("/tmp/a/report.md"));
    events.append(session.id, sessionEvent("assistant_text", { messageId: "m", text: "done" }));
    // THE mutant: index from the session service instead of from `append`. The pump, `emitExternal`
    // and boot's synthetic denials all reach the log by other routes, and each would skip the index.
    expect(artifacts.list({}).map((a) => a.name)).toEqual(["report.md"]);
    expect(artifacts.count(null)).toBe(1);
  });

  it("joins the session's title at READ time, so renaming a session relabels its files", () => {
    const { events, session, sessions, artifacts } = fresh();
    events.append(session.id, write("/tmp/a/report.md"));
    expect(artifacts.list({})[0]!.sessionTitle).toBe("New session");
    sessions.update({ id: session.id, title: "The parser rewrite" });
    // A title copied into the artifact row would have frozen the old one here.
    expect(artifacts.list({})[0]!.sessionTitle).toBe("The parser rewrite");
  });

  it("re-indexing the same event is an upsert, not a duplicate", () => {
    /* The property the backfill depends on: it and the append-time writer both cover the events
       either side of the cursor, and neither knows about the other. */
    const { events, session, artifacts, db } = fresh();
    const stored = events.append(session.id, write("/tmp/a/report.md"));
    artifacts.index(session.id, stored.seq, stored.event.ts, "tool_call", stored.event.payload);
    expect((db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number }).n).toBe(1);
  });

  it("pages by keyset, so a page boundary inside one millisecond neither repeats nor drops a row", () => {
    const { events, session, artifacts } = fresh();
    // Three writes at the SAME timestamp — the case an ORDER BY ts alone cannot page through.
    const ts = 1_700_000_000_000;
    for (const name of ["a.md", "b.md", "c.md"]) {
      events.append(session.id, { ...write(`/tmp/${name}`), ts });
    }
    const first = artifacts.list({ limit: 2 });
    expect(first).toHaveLength(2);
    const rest = artifacts.list({ limit: 2, before: { ts: first[1]!.ts, id: first[1]!.id } });
    const seen = [...first, ...rest].map((a) => a.name);
    expect(new Set(seen).size).toBe(3);
    expect(seen).toHaveLength(3);
  });

  it("searches the NAME, treats a wildcard in the query as a literal, and filters by kind and space", () => {
    const { events, session, artifacts, space } = fresh();
    events.append(session.id, write("/tmp/reports/summary.md"));
    events.append(session.id, write("/tmp/notes/100%-done.md"));
    events.append(session.id, sessionEvent("user_message", { text: "here", attachments: [{ path: "/tmp/photo.png", mime: "image/png" }] }));

    // The directory is not searched: someone hunting for summary.md should not also match every
    // file under /tmp/reports.
    expect(artifacts.list({ query: "reports" })).toEqual([]);
    expect(artifacts.list({ query: "summary" }).map((a) => a.name)).toEqual(["summary.md"]);
    /* THE injection mutant: interpolate the needle into LIKE unescaped. The needle here is a bare
       wildcard, so unescaped it matches all three rows; escaped it matches only the one file whose
       name really contains a per-cent sign. ("100%" would NOT catch it — that still only matches
       the same single row either way, which is how this test passed the mutant the first time.) */
    expect(artifacts.list({ query: "%" }).map((a) => a.name)).toEqual(["100%-done.md"]);
    // Same for the single-character wildcard.
    expect(artifacts.list({ query: "_" })).toEqual([]);
    expect(artifacts.list({ kind: "upload" }).map((a) => a.name)).toEqual(["photo.png"]);
    expect(artifacts.list({ spaceId: space.id })).toHaveLength(3);
    expect(artifacts.list({ spaceId: "nope" })).toEqual([]);
    expect(artifacts.count("nope")).toBe(0);
  });

  it("goes with the session: deleting one takes its files out of the Library", () => {
    const { events, session, sessions, artifacts } = fresh();
    events.append(session.id, write("/tmp/a/report.md"));
    sessions.delete(session.id);
    // ON DELETE CASCADE, not a second delete to remember — an index row pointing at a session that
    // no longer exists is a row the read's own JOIN would drop anyway, silently and forever.
    expect(artifacts.list({})).toEqual([]);
  });
});

describe("the artifacts backfill", () => {
  it("indexes history the append-time writer never saw, and is idempotent across runs", async () => {
    const { db, session, artifacts, settings } = fresh();
    // Events written WITHOUT the index — exactly the state a home upgraded to v25 is in.
    const bare = new SessionEventsStore(db);
    const a = bare.append(session.id, write("/tmp/old/one.md"));
    const b = bare.append(session.id, write("/tmp/old/two.md"));
    expect(artifacts.list({})).toEqual([]);

    settings.set(ARTIFACTS_BACKFILL_KEY, { done: 0, target: b.seq });
    await artifacts.runBackfill(() => false, () => {});
    expect(artifacts.list({}).map((x) => x.name).sort()).toEqual(["one.md", "two.md"]);
    expect(artifacts.readCursor()).toEqual({ done: b.seq, target: b.seq });

    // Running it again does nothing at all: the cursor has caught up, and even if it had not, the
    // deterministic id makes every insert an upsert.
    await artifacts.runBackfill(() => false, () => {});
    expect(artifacts.list({})).toHaveLength(2);
    expect(a.seq).toBeLessThan(b.seq);
  });

  it("stops when asked, leaving the cursor where the next boot can resume from", async () => {
    const { db, session, artifacts, settings } = fresh();
    const bare = new SessionEventsStore(db);
    const last = bare.append(session.id, write("/tmp/old/one.md"));
    settings.set(ARTIFACTS_BACKFILL_KEY, { done: 0, target: last.seq });
    await artifacts.runBackfill(() => true, () => {});
    expect(artifacts.list({})).toEqual([]);
    expect(artifacts.readCursor()).toEqual({ done: 0, target: last.seq });
  });
});
