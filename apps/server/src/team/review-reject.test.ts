import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { REVIEW_STATES, type ReviewState } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { TeamStore } from "./store";
import { TeamService } from "./service";
import { createTeamAgentProvider } from "./agent-tools";
import { RecordTypeStore } from "./record-types/store";
import { RecordTypeService } from "./record-types/service";
import { ActStore } from "./acts/store";
import { ActService, type TicketPress } from "./acts/service";
import type { ActAdapter, ActRequest, ActResult } from "./acts/adapters";

/**
 * The person's Reject and Close in Review, and the state machine around them: which states each may
 * leave, what a reason does, and the race that matters — closing an approved batch while one of its
 * sends is with the platform. Each test names the one-line mutant it kills.
 */

/** Friday 9 October 2026, 2:00 PM local: inside the window acts are planned in. */
const T0 = new Date(2026, 9, 9, 14, 0, 0, 0).getTime();

/** A platform whose act waits until the test lets it go, the way a real send takes seconds. */
class SlowPlatform implements ActAdapter {
  calls: ActRequest[] = [];
  private pending: ((r: ActResult) => void)[] = [];
  status() { return { connected: true, label: "Fake", why: null }; }
  act(req: ActRequest): Promise<ActResult> {
    this.calls.push(req);
    return new Promise((resolve) => { this.pending.push(resolve); });
  }
  /** The platform answers the oldest act in flight. */
  answer(r: ActResult): void { this.pending.shift()?.(r); }
}

function setup() {
  const home = tempDir("realm-review-reject-");
  const db = openDatabase(join(home, "realm.db"));
  db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES ('p', 'P', 'x', '#000', 0, 1, 1)").run();
  const folder = join(home, "space");
  mkdirSync(folder, { recursive: true });
  db.prepare("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at) VALUES ('S1', 'p', 'S1', 'f', 0, ?, 1, 1)").run(folder);
  for (const [id, wakes] of [["R1", 1], ["R2", 0]] as const)
    db.prepare("INSERT INTO team_roles (id, space_id, name, brief, realmite_json, agent_kind, wake_on_review, created_at, updated_at) VALUES (?, 'S1', ?, 'Write.', '{}', 'fake', ?, 1, 1)")
      .run(id, id === "R1" ? "Writer" : "Quiet", wakes);
  let now = T0;
  const clock = () => now;
  const store = new TeamStore(db, clock);
  const platform = new SlowPlatform();
  const pressed = new Set<string>();
  const acts = new ActService({
    store: new ActStore(db, clock), team: store, rootForSpace: () => folder, record: () => null,
    presses: { consume: async (id: string): Promise<TicketPress> => ({ pressed: pressed.delete(id), label: false, slotAt: null }) },
    adapter: () => platform, proofDir: join(home, "proof"), rpc: { broadcast: () => {} }, clock,
  });
  const live: { id: string; sessionId: string; roleId: string; dedupeKey: string | null; spaceId: string; state: string }[] = [];
  const woken: { roleId: string; goal: string; sessionId: string | null; dedupeKey: string | null }[] = [];
  const recordTypes = new RecordTypeService({ store: new RecordTypeStore(db), repoPath: () => null, spaceExists: () => true, log: () => {}, changed: () => {} });
  const team = new TeamService({
    store, recordTypes, acts,
    runs: {
      get: () => null, listLive: () => live, spentSince: () => 0, listForRole: () => [],
      create: (input: { roleId: string; goal: string; sessionId: string | null; dedupeKey: string | null }) => {
        woken.push({ roleId: input.roleId, goal: input.goal, sessionId: input.sessionId, dedupeKey: input.dedupeKey });
        return { run: { id: `woken-${woken.length}`, state: "running", spaceId: "S1", sessionId: input.sessionId }, created: true };
      },
    } as never,
    schedules: { forRole: () => null } as never, sessions: { publishServerEvent: () => {} } as never,
    repos: { config: () => null } as never,
    rootForSpace: () => folder, spaceExists: () => true,
    settings: { get: () => undefined, set: () => {} }, rpc: { broadcast: () => {} }, clock,
  });
  const tools = createTeamAgentProvider({ team, types: recordTypes, mcp: { providerEnabled: () => true } });
  /** A role's run on a session, live; `dedupeKey` is how a run woken on a review revises it. */
  const running = (roleId: string, sessionId: string, dedupeKey: string | null = null) => {
    live.push({ id: `run-${sessionId}`, sessionId, roleId, dedupeKey, spaceId: "S1", state: "running" });
    return { sessionId, spaceId: "S1" };
  };
  /** Two emails from the person's own address: acts that need no creator's consent. */
  const emails = (ctx: { sessionId: string; spaceId: string }, title = "Replies") => team.submit(ctx, {
    kind: "message", title,
    items: [1, 2].map((n) => ({ files: [], body: `Hi ${n}`, target: { channel: "email", account: "me@realm.test", to: `reader${n}@realm.test` } })),
  });
  const draft = (ctx: { sessionId: string; spaceId: string }, title = "Reply to Dana") => team.submit(ctx, { kind: "replies", title, items: [{ files: [], body: "Hi Dana" }] });
  const press = (id: string) => { pressed.add(id); return acts.post(id); };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { db, team, store, acts, platform, tools, woken, live, running, emails, draft, press, flush, setNow: (t: number) => { now = t; } };
}

/** Puts a review in `state` the way the product gets it there. */
function into(s: ReturnType<typeof setup>, id: string, state: ReviewState): void {
  if (state === "changes") s.team.requestChanges(id, "shorter");
  else if (state === "approved") s.team.approve(id);
  else if (state === "done") s.team.markDone(id);
  else if (state === "dismissed") s.team.dismiss(id);
  else if (state === "rejected") s.team.reject(id, null);
  else if (state === "closed") s.team.closeReview(id);
}

describe("the person's Reject and Close: the state machine", () => {
  it.each(["waiting", "changes", "approved"] as const)("rejects and closes a review that is %s", (state) => {
    for (const verb of ["rejected", "closed"] as const) {
      const s = setup();
      const r = s.draft(s.running("R2", `SESS-${verb}`));
      into(s, r.id, state);
      const out = verb === "rejected" ? s.team.reject(r.id, null) : s.team.closeReview(r.id);
      expect(out.state).toBe(verb);
      expect(s.store.review(r.id)!.decidedAt).toBe(T0);
      expect(s.store.activity("S1", 1)[0]).toMatchObject({ actor: "user", verb, detail: { reviewId: r.id, from: state } });
    }
  });

  it.each(["done", "dismissed", "rejected", "closed"] as const)("refuses to reject or close a review that is already %s, and leaves it as it was", (state) => {
    const s = setup();
    const r = s.draft(s.running("R2", "SESS"));
    into(s, r.id, state);
    // THE MUTANT: `mustOpenReview` reads the review without the final-state check — a Close on a
    // rejected batch rewrites the person's no, and one on a done batch claims it never went out.
    expect(() => s.team.reject(r.id, "no")).toThrow(/already/);
    expect(() => s.team.closeReview(r.id)).toThrow(/already/);
    expect(s.store.review(r.id)!.state).toBe(state);
  });

  it("names every state the machine has, so a new one must be placed here before it ships", () => {
    expect(REVIEW_STATES).toEqual(["waiting", "changes", "approved", "done", "dismissed", "rejected", "closed"]);
  });

  it("nothing reopens a rejected or closed review: not changes, not done, not the role's close", async () => {
    const s = setup();
    const ctx = s.running("R2", "SESS");
    for (const end of ["rejected", "closed"] as const) {
      const r = s.draft(ctx, end);
      into(s, r.id, end);
      expect(() => s.team.requestChanges(r.id, "again")).toThrow(/rejected|closed/);
      expect(() => s.team.markDone(r.id)).toThrow(/rejected|closed/);
      expect(() => s.team.approve(r.id)).toThrow();
      const out = await s.tools.call(ctx as never, "review_close", { id: r.id, outcome: "withdrawn" });
      expect(out.isError).toBe(true);
      expect(s.store.review(r.id)!.state).toBe(end);
    }
  });

  it("keeps rejected and closed reviews in the space's list, so Review can show them as history", () => {
    const s = setup();
    const ctx = s.running("R2", "SESS");
    const a = s.draft(ctx, "a"); const b = s.draft(ctx, "b");
    s.team.reject(a.id, "off-brand");
    s.team.closeReview(b.id);
    // THE MUTANT: `space()` filtering finished reviews out — the history group would be empty.
    expect(s.team.space("S1").reviews.map((r) => [r.title, r.state, r.note])).toEqual(expect.arrayContaining([["a", "rejected", "off-brand"], ["b", "closed", null]]));
  });
});

describe("a reason goes back to the role that sent it", () => {
  it("wakes the role on the review's own session with the person's words, and a key that never revises it", () => {
    const s = setup();
    const r = s.draft(s.running("R1", "WRITER"));
    s.team.reject(r.id, "  We never reply to Dana by email.  ");
    expect(s.store.review(r.id)).toMatchObject({ state: "rejected", note: "We never reply to Dana by email." });
    // THE MUTANT: no wake — the role is never told, and makes the same thing tomorrow.
    expect(s.woken).toHaveLength(1);
    expect(s.woken[0]).toMatchObject({ roleId: "R1", sessionId: "WRITER", dedupeKey: `reject:${r.id}:1` });
    expect(s.woken[0]!.goal).toContain("We never reply to Dana by email.");
    expect(s.woken[0]!.goal).toContain("Do not send it again");
  });

  it("spends no run on a no without a reason, or on a role that does not wake on reviews", () => {
    const s = setup();
    const quiet = s.draft(s.running("R1", "WRITER"), "quiet");
    s.team.reject(quiet.id, "   ");
    const other = s.draft(s.running("R2", "OTHER"), "other");
    s.team.reject(other.id, "not this");
    // THE MUTANT: waking on any rejection — a run billed to say nothing.
    expect(s.woken).toEqual([]);
    expect(s.store.review(quiet.id)!.note).toBeNull();
  });

  it("tells the role's own review_status, reason and all", async () => {
    const s = setup();
    const ctx = s.running("R2", "SESS");
    const r = s.draft(ctx);
    s.team.reject(r.id, "Too long");
    const out = await s.tools.call(ctx as never, "review_status", { id: r.id });
    expect((out.content as { text: string }[])[0]!.text).toContain("rejected by the person; nothing of it goes out, so do not send it again: Too long");
  });

  it("what the woken run sends is a new review: the rejected one stays as the person left it", () => {
    const s = setup();
    const r = s.draft(s.running("R1", "WRITER"));
    s.team.reject(r.id, "No");
    const again = s.draft(s.running("R1", "WRITER-2", s.woken[0]!.dedupeKey), "Reply to Dana, take two");
    expect(again.id).not.toBe(r.id);
    expect(s.store.review(r.id)!.state).toBe("rejected");
  });

  it("a revision asked for before the person closed it does not reopen it", () => {
    const s = setup();
    const r = s.draft(s.running("R1", "WRITER"));
    s.team.requestChanges(r.id, "shorter");
    expect(s.woken[0]!.dedupeKey).toBe(`review:${r.id}:1`);
    // The person gives up on it while the role is still working on the changes.
    s.team.closeReview(r.id);
    const late = s.draft(s.running("R1", "WRITER-2", s.woken[0]!.dedupeKey), "shorter reply");
    // THE MUTANT: `submit` revising whatever its run was woken for — the closed batch is waiting again.
    expect(late.id).not.toBe(r.id);
    expect(s.store.review(r.id)).toMatchObject({ state: "closed", version: 1 });
    expect(s.store.review(late.id)!.state).toBe("waiting");
  });
});

describe("closing an approved batch that has not sent yet", () => {
  it("takes back every ticket still waiting for a press or a slot, and nothing goes out after", async () => {
    const s = setup();
    const r = s.emails(s.running("R2", "SESS"));
    s.team.approve(r.id);
    const [first, second] = s.acts.tickets(r.id);
    expect(second!.slotAt).toBeGreaterThan(T0);
    // The second is pressed for its slot a minute out; the first still waits for its press.
    await s.press(second!.id);
    expect(s.acts.ticket(second!.id).state).toBe("scheduled");
    s.team.closeReview(r.id);
    expect([first!, second!].map((t) => s.acts.ticket(t.id).state)).toEqual(["cancelled", "cancelled"]);
    // The slot comes; and a press that was on its way arrives late.
    s.setNow(second!.slotAt + 1_000);
    await s.acts.execute(second!.id);
    await expect(s.press(first!.id)).rejects.toThrow();
    await s.flush();
    expect(s.platform.calls).toEqual([]);
    expect(s.store.review(r.id)!.state).toBe("closed");
  });

  it("an act already with the platform when it closes: what went out is told as it was, and the review stays closed", async () => {
    const s = setup();
    const r = s.emails(s.running("R2", "SESS"));
    s.team.approve(r.id);
    const [first] = s.acts.tickets(r.id);
    await s.press(first!.id);
    await s.flush();
    expect(s.acts.ticket(first!.id).state).toBe("acting");
    s.team.closeReview(r.id);
    // The send had already left: the platform says it went.
    s.platform.answer({ ok: true, url: "https://mail.invalid/1", screenshot: null });
    await s.flush();
    expect(s.acts.ticket(first!.id)).toMatchObject({ state: "done", proofUrl: "https://mail.invalid/1" });
    // THE MUTANT: `execute` marking the batch done once every live ticket went out, whatever the
    // person did meanwhile — the closed review flips to done and leaves the history it was in.
    expect(s.store.review(r.id)!.state).toBe("closed");
    expect(s.acts.tickets(r.id).map((t) => t.state)).toEqual(["done"]);
    expect(s.team.summary(s.store.review(r.id)!)).toMatchObject({ state: "closed", actsDone: 1, actsTotal: 1 });
  });

  it("an act the close stopped in time is cancelled, never handed back for another press", async () => {
    const s = setup();
    const r = s.emails(s.running("R2", "SESS"));
    s.team.approve(r.id);
    const [first] = s.acts.tickets(r.id);
    await s.press(first!.id);
    await s.flush();
    const aborted = s.platform.calls[0]!.signal;
    s.team.reject(r.id, "wrong tone");
    // The close reached the act: its signal fired, and the platform gave up before sending.
    expect(aborted.aborted).toBe(true);
    s.platform.answer({ ok: false, error: "held before it went out", screenshot: null });
    await s.flush();
    // THE MUTANT: the failure path's `ready` — a rejected batch offers its Send again.
    expect(s.acts.ticket(first!.id)).toMatchObject({ state: "cancelled", error: "Stopped before it went out: you rejected it." });
    expect(s.store.review(r.id)!.state).toBe("rejected");
  });
});
