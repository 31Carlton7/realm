import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { ACT_PACING, type ActKind } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { TeamStore } from "./store";
import { TeamService } from "./service";
import { createTeamAgentProvider } from "./agent-tools";
import { RecordTypeStore } from "./record-types/store";
import { RecordTypeService } from "./record-types/service";

/**
 * `review_close`: a role closes a review it sent, so a finished draft leaves Needs you without the
 * person's hand — and never one another role, session or space sent. Each test names its mutant.
 */

function setup() {
  const home = tempDir("realm-review-close-");
  const db = openDatabase(join(home, "realm.db"));
  db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES ('p', 'P', 'x', '#000', 0, 1, 1)").run();
  const folder = join(home, "space");
  mkdirSync(folder, { recursive: true });
  for (const s of ["S1", "S2"])
    db.prepare("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at) VALUES (?, 'p', ?, 'f', 0, ?, 1, 1)").run(s, s, folder);
  for (const [id, space, name] of [["R1", "S1", "Writer"], ["R2", "S1", "Editor"], ["R3", "S2", "Writer"]] as const)
    db.prepare("INSERT INTO team_roles (id, space_id, name, brief, realmite_json, agent_kind, created_at, updated_at) VALUES (?, ?, ?, 'Write.', '{}', 'fake', 1, 1)").run(id, space, name);
  let now = 1_000;
  const live: { id: string; sessionId: string; roleId: string; dedupeKey: null }[] = [];
  const broadcasts: unknown[] = [];
  const store = new TeamStore(db, () => now);
  const recordTypes = new RecordTypeService({ store: new RecordTypeStore(db), repoPath: () => null, spaceExists: () => true, log: () => {}, changed: () => {} });
  const team = new TeamService({
    store, recordTypes,
    acts: { issue: () => [], cancelForReview: () => {}, tickets: () => [], counts: () => ({ total: 0, done: 0 }), held: () => false,
      today: (k: ActKind) => ({ count: 0, cap: ACT_PACING[k].perDay }) },
    runs: { get: () => null, listLive: () => live, spentSince: () => 0 } as never,
    schedules: {} as never, sessions: { publishServerEvent: () => {} } as never,
    repos: { config: () => null } as never,
    rootForSpace: () => folder, spaceExists: () => true,
    settings: { get: () => undefined, set: () => {} }, rpc: { broadcast: (m: string, p: unknown) => broadcasts.push([m, p]) }, clock: () => now,
  });
  const tools = createTeamAgentProvider({ team, types: recordTypes, mcp: { providerEnabled: () => true } });
  /** A role's run on a session, live. */
  const running = (roleId: string, sessionId: string) => { live.push({ id: `run-${sessionId}`, sessionId, roleId, dedupeKey: null }); return { sessionId, spaceId: roleId === "R3" ? "S2" : "S1" }; };
  const draft = (ctx: { sessionId: string; spaceId: string }, title = "Reply to Dana") => team.submit(ctx, { kind: "replies", title, items: [{ files: [], body: "Hi Dana" }] });
  const call = async (ctx: { sessionId: string; spaceId: string }, args: unknown) => {
    const out = await tools.call(ctx as never, "review_close", args);
    return { error: out.isError === true, text: (out.content as { text: string }[]).map((c) => c.text).join("\n") };
  };
  const tick = () => { now += 1_000; };
  return { db, team, store, live, broadcasts, running, draft, call, tick };
}

describe("review_close", () => {
  it("is offered beside review_submit, and review_submit's answer names the id it closes by", async () => {
    const { team, store, running } = setup();
    const ctx = running("R1", "SESS");
    const tools = createTeamAgentProvider({ team, types: { describe: () => "", descriptions: () => ({ types: "", list: "", read: "", update: "", path: "", section: "" }) } as never, mcp: { providerEnabled: () => true } });
    expect((await tools.tools(ctx as never)).map((t) => t.name)).toContain("review_close");
    const out = await tools.call(ctx as never, "review_submit", { label: "replies", title: "Reply", items: [{ body: "Hi" }] });
    const id = store.reviews("S1")[0]!.id;
    expect((out.content as { text: string }[])[0]!.text).toContain(`review ${id}`);
    expect((out.content as { text: string }[])[0]!.text).toContain("review_close");
  });

  it("closes the role's own waiting draft: it leaves what waits on the person, with the outcome and reason logged", async () => {
    const { team, store, broadcasts, running, draft, call } = setup();
    const ctx = running("R1", "SESS");
    const r = draft(ctx);
    expect(store.waiting().map((x) => x.id)).toEqual([r.id]);
    broadcasts.length = 0;
    const out = await call(ctx, { id: r.id, outcome: "withdrawn", reason: "Dana already replied" });
    expect(out).toEqual({ error: false, text: `Closed review ${r.id} "Reply to Dana" as withdrawn; it no longer waits on the person.` });
    expect(store.review(r.id)).toMatchObject({ state: "dismissed", note: "Dana already replied" });
    expect(store.waiting()).toEqual([]);
    // The window re-reads the team on this, which is what takes the row out of Needs you live.
    // THE MUTANT: closing without `changed` — the row stays in the sidebar until something else moves.
    expect(broadcasts).toEqual([["team.changed", { spaceId: "S1" }]]);
    const log = store.activity("S1", 10)[0]!;
    expect(log).toMatchObject({ actor: "role:R1", verb: "closed", object: "Reply to Dana", detail: { reviewId: r.id, outcome: "withdrawn", reason: "Dana already replied" } });
    void team;
  });

  it("files `done` as done, and `superseded` as put away", async () => {
    const { store, running, draft, call } = setup();
    const ctx = running("R1", "SESS");
    const a = draft(ctx, "a");
    const b = draft(ctx, "b");
    expect((await call(ctx, { id: a.id, outcome: "done" })).error).toBe(false);
    expect((await call(ctx, { id: b.id, outcome: "superseded" })).error).toBe(false);
    expect(store.review(a.id)!.state).toBe("done");
    expect(store.review(b.id)!.state).toBe("dismissed");
  });

  it("closes what the same role sent in an earlier run, and what this session sent without a role", async () => {
    const { store, live, running, draft, call } = setup();
    const first = running("R1", "OLD");
    const r = draft(first);
    live.length = 0;
    const later = running("R1", "NEW");
    expect((await call(later, { id: r.id, outcome: "superseded" })).error).toBe(false);
    // A person's own session in a team space, no role: its own submission only.
    const mine = { sessionId: "CHAT", spaceId: "S1" };
    const own = draft(mine);
    expect((await call(mine, { id: own.id, outcome: "withdrawn" })).error).toBe(false);
    expect(store.review(own.id)!.state).toBe("dismissed");
  });

  it("refuses another role's review in the same space, and leaves it waiting", async () => {
    const { store, running, draft, call } = setup();
    const theirs = draft(running("R2", "EDITOR"));
    const out = await call(running("R1", "WRITER"), { id: theirs.id, outcome: "withdrawn" });
    // THE MUTANT: the ownership check dropped — any role on the team clears any review.
    expect(out.error).toBe(true);
    expect(out.text).toMatch(/sent by someone else/);
    expect(store.review(theirs.id)!.state).toBe("waiting");
    // Nor a roleless session's review, from a session that did not send it.
    const chat = draft({ sessionId: "CHAT", spaceId: "S1" });
    expect((await call({ sessionId: "OTHER", spaceId: "S1" }, { id: chat.id, outcome: "withdrawn" })).error).toBe(true);
    expect(store.review(chat.id)!.state).toBe("waiting");
  });

  it("refuses a review of another space as unknown, even one its own session sent there", async () => {
    const { store, running, draft, call } = setup();
    const elsewhere = draft(running("R3", "S2SESS"));
    const out = await call({ sessionId: "S2SESS", spaceId: "S1" }, { id: elsewhere.id, outcome: "withdrawn" });
    // THE MUTANT: the space check dropped — a session reaches across into another space's Review.
    expect(out.error).toBe(true);
    expect(out.text).toMatch(/not found/i);
    expect(store.review(elsewhere.id)!.state).toBe("waiting");
  });

  it("refuses an unknown id, and a bad outcome", async () => {
    const { running, call } = setup();
    const ctx = running("R1", "SESS");
    expect(await call(ctx, { id: "01JZZZZZZZZZZZZZZZZZZZZZZZ", outcome: "withdrawn" })).toMatchObject({ error: true, text: expect.stringMatching(/not found/i) });
    expect((await call(ctx, { id: "x", outcome: "deleted" })).error).toBe(true);
  });

  it("refuses what is already closed or decided: a yes, a done, a put-away are the person's", async () => {
    const { team, store, running, draft, call } = setup();
    const ctx = running("R1", "SESS");
    const closed = draft(ctx, "closed");
    await call(ctx, { id: closed.id, outcome: "withdrawn", reason: "first" });
    const again = await call(ctx, { id: closed.id, outcome: "done", reason: "second" });
    // THE MUTANT: no state check — a second close rewrites the first, or a done batch is put away.
    expect(again).toMatchObject({ error: true, text: expect.stringMatching(/already put away/) });
    expect(store.review(closed.id)).toMatchObject({ state: "dismissed", note: "first" });
    const approved = draft(ctx, "approved");
    team.approve(approved.id);
    expect((await call(ctx, { id: approved.id, outcome: "withdrawn" })).text).toMatch(/already approved by the person/);
    expect(store.review(approved.id)!.state).toBe("approved");
  });

  it("closes a review the person asked changes on", async () => {
    const { store, running, draft, call } = setup();
    const ctx = running("R1", "SESS");
    const r = draft(ctx);
    store.setReviewState(r.id, "changes", { note: "shorter", decided: true });
    expect((await call(ctx, { id: r.id, outcome: "superseded", reason: "sent as a new batch" })).error).toBe(false);
    expect(store.review(r.id)).toMatchObject({ state: "dismissed", note: "sent as a new batch" });
  });

  it("refuses a secret in the reason", async () => {
    const { store, running, draft, call } = setup();
    const ctx = running("R1", "SESS");
    const r = draft(ctx);
    expect((await call(ctx, { id: r.id, outcome: "withdrawn", reason: "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" })).text).toMatch(/looks like an API key/);
    expect(store.review(r.id)!.state).toBe("waiting");
  });
});

describe("what Review is told about a review", () => {
  it("says how a role closed its own review, and nothing for the person's close or dismiss", async () => {
    const { team, store, running, draft, call, tick } = setup();
    const ctx = running("R1", "SESS");
    const [replaced, withdrawn, mine, putAway] = ["a", "b", "c", "d"].map((t) => draft(ctx, t));
    tick();
    await call(ctx, { id: replaced!.id, outcome: "superseded", reason: "the new batch replaces it" });
    await call(ctx, { id: withdrawn!.id, outcome: "withdrawn" });
    team.closeReview(mine!.id);
    team.dismiss(putAway!.id);
    const byTitle = Object.fromEntries(store.reviews("S1").map((r) => [r.title, team.summary(r)]));
    // THE MUTANT: `closedAs` read off the state — every put-away review would read "replaced".
    expect(byTitle.a).toMatchObject({ state: "dismissed", closedAs: "superseded", note: "the new batch replaces it" });
    expect(byTitle.b).toMatchObject({ state: "dismissed", closedAs: "withdrawn" });
    // The person's close and the old Dismiss carry no outcome of a role's.
    expect(byTitle.c).toMatchObject({ state: "closed", closedAs: null });
    expect(byTitle.d).toMatchObject({ state: "dismissed", closedAs: null });
  });

  it("carries the role's note to the reader, refuses a secret in it, and drops it from a revision that says nothing new", async () => {
    const { team, store, live, running } = setup();
    const ctx = running("R1", "SESS");
    const tools = createTeamAgentProvider({ team, types: { describe: () => "", descriptions: () => ({ types: "", list: "", read: "", update: "", path: "", section: "" }) } as never, mcp: { providerEnabled: () => true } });
    const submit = (args: unknown) => tools.call(ctx as never, "review_submit", args);
    await submit({ label: "replies", title: "Reply to Dana", note: "She asked for the date in writing.", items: [{ body: "Hi Dana" }] });
    const r = store.reviews("S1")[0]!;
    // THE MUTANT: the note dropped between the tool and the activity line — the reader has nothing to quote.
    expect(team.review(r.id).why).toBe("She asked for the date in writing.");
    // The person's own edit is a new version, and the note still speaks for the work.
    team.editItem(r.id, team.review(r.id).items[0]!.id, "Hi Dana, the 14th.");
    expect(team.review(r.id)).toMatchObject({ version: 2, why: "She asked for the date in writing." });
    const refused = await submit({ label: "replies", title: "Key", note: "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", items: [{ body: "x" }] });
    expect(refused.isError).toBe(true);
    expect(store.reviews("S1").map((x) => x.title)).not.toContain("Key");
    // A revision the role sends without a note says nothing about why — not the first version's reason.
    live[0]!.dedupeKey = `review:${r.id}:2` as never;
    await submit({ label: "replies", title: "Reply to Dana", items: [{ body: "Hi Dana, Wednesday the 14th." }] });
    expect(team.review(r.id)).toMatchObject({ version: 3, why: null });
  });
});
