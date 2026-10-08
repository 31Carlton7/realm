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
  return { db, home, space, session, sessions, events, artifacts, settings, profile: p, env };
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

  it("takes each file a turn left on disk off files_made, as an output", () => {
    const at = { sessionId: "s1", spaceId: "sp1", seq: 9, ts: 200 };
    const rows = artifactsFromEvent({
      ...at, type: "files_made",
      payload: { settledAt: 200, files: [{ path: "/w/decks/v1/01.png", size: 10 }, { path: "/w/decks/clip.MP4", size: 20 }], totalFiles: 2 },
    });
    // THE mutants: no files_made branch (nothing), or one that files them as uploads.
    expect(rows.map((a) => [a.kind, a.name, a.ext])).toEqual([["output", "01.png", "png"], ["output", "clip.MP4", "mp4"]]);
    expect(artifactsFromEvent({ ...at, type: "files_made", payload: { settledAt: 1, files: "no", totalFiles: 0 } })).toEqual([]);
  });

  it("takes Codex's generated image off its saved path, and nothing off a generation that failed", () => {
    const at = { sessionId: "s1", spaceId: "sp1", seq: 3, ts: 1 };
    // THE mutant: image_generation left out of WRITE_TOOL_NAMES.
    expect(artifactsFromEvent({ ...at, type: "tool_call", payload: { name: "image_generation", input: { path: "/g/exec-1.png", prompt: "a logo" } } })
      .map((a) => a.path)).toEqual(["/g/exec-1.png"]);
    expect(artifactsFromEvent({ ...at, type: "tool_call", payload: { name: "image_generation", input: { prompt: "a logo" } } })).toEqual([]);
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

  it("narrows by the type a file reads as — answered by the index, and Other as everything no type claims", () => {
    const { events, session, artifacts } = fresh();
    for (const name of ["shot.PNG", "brief.pdf", "index.ts", "usage.csv", "bundle.zip", "Makefile"]) events.append(session.id, write(`/tmp/${name}`));
    const names = (type: Parameters<typeof artifacts.list>[0]["type"]) => artifacts.list({ type }).map((a) => a.name).sort();
    expect(names("image")).toEqual(["shot.PNG"]);
    expect(names("document")).toEqual(["brief.pdf"]);
    expect(names("code")).toEqual(["index.ts"]);
    expect(names("data")).toEqual(["usage.csv"]);
    /* THE mutants: "other" as an IN over an empty list (nothing, ever), or as no filter at all
       (everything). It is the complement — a file with no extension is other too. */
    expect(names("other")).toEqual(["Makefile", "bundle.zip"]);
    expect(names(null)).toHaveLength(6);
  });

  it("means every space of ONE profile by \"every space\", and counts the same way", () => {
    /* Profiles are separate homes for their spaces (Plan 27). THE mutant: a null spaceId that reads
       the whole table, so a Work window's Library lists what Personal's sessions made, and its
       "nothing here yet" counts them too. */
    const { db, home, events, session, sessions, artifacts, profile } = fresh();
    const other = new ProfilesStore(db).create({ name: "Other", icon: "x", color: "#111" });
    const theirs = new SpacesStore(db, home).create({ profileId: other.id, name: "T", icon: "f" });
    const theirEnv = new EnvironmentsStore(db).ensurePrimary(theirs.id);
    const theirSession = sessions.create({
      spaceId: theirs.id, projectId: null, agentKind: "fake", model: null, effort: null,
      permissionMode: "default", environmentId: theirEnv.id, title: "Theirs",
    });
    events.append(session.id, write("/tmp/mine.md"));
    events.append(theirSession.id, write("/tmp/theirs.md"));
    expect(artifacts.list({ profileId: profile.id }).map((a) => a.name)).toEqual(["mine.md"]);
    expect(artifacts.list({ profileId: other.id }).map((a) => a.name)).toEqual(["theirs.md"]);
    expect(artifacts.count(null, profile.id)).toBe(1);
    // Asked for the whole home, it is the whole home.
    expect(artifacts.list({}).map((a) => a.name).sort()).toEqual(["mine.md", "theirs.md"]);
    expect(artifacts.count(null)).toBe(2);
  });

  it("narrows to one session — the documents pane's \"This session\" — and counts it the same way", () => {
    /* THE mutant: a sessionId the query accepts and never applies, so a brand-new session's pane
       lists every file the space has ever seen as its own. */
    const { events, session, sessions, artifacts, space, env } = fresh();
    const other = sessions.create({
      spaceId: space.id, projectId: null, agentKind: "fake", model: null, effort: null,
      permissionMode: "default", environmentId: env.id, title: "Other",
    });
    events.append(session.id, write("/tmp/mine.md"));
    events.append(other.id, write("/tmp/theirs.md"));
    expect(artifacts.list({ sessionId: session.id }).map((a) => a.name)).toEqual(["mine.md"]);
    expect(artifacts.list({ sessionId: other.id }).map((a) => a.name)).toEqual(["theirs.md"]);
    expect(artifacts.count(null, null, { sessionId: session.id })).toBe(1);
    expect(artifacts.count(space.id)).toBe(2);
  });

  it("lists a file once per file when asked, at the last time it was touched, and pages over that", () => {
    const { events, session, artifacts } = fresh();
    // report.md written, then plan.md, then report.md edited twice more: four events, two files.
    const at = (path: string, ts: number) => events.append(session.id, { ...write(path), ts });
    at("/tmp/report.md", 100);
    at("/tmp/plan.md", 200);
    at("/tmp/report.md", 300);
    at("/tmp/report.md", 400);
    expect(artifacts.list({}).map((a) => a.name)).toEqual(["report.md", "report.md", "plan.md", "report.md"]);
    /* THE mutant: collapse with GROUP BY and no ordering, which keeps whichever row SQLite meets
       first — the report at 100, sorted under the plan it was edited after. */
    const files = artifacts.list({ perFile: true });
    expect(files.map((a) => [a.name, a.ts])).toEqual([["report.md", 400], ["plan.md", 200]]);
    expect(artifacts.count(null, null, { perFile: true })).toBe(2);
    /* The keyset runs over the collapsed list. THE mutant: the cursor inside the inner query, where
       it cuts the report's newest row off and its row at 300 comes back as the newest — the same
       file on the second page as on the first. */
    const first = artifacts.list({ perFile: true, limit: 1 });
    const rest = artifacts.list({ perFile: true, limit: 1, before: { ts: first[0]!.ts, id: first[0]!.id } });
    expect([...first, ...rest].map((a) => a.name)).toEqual(["report.md", "plan.md"]);
    expect(artifacts.list({ perFile: true, limit: 1, before: { ts: rest[0]!.ts, id: rest[0]!.id } })).toEqual([]);
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
