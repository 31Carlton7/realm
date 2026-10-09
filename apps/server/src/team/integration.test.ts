import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import WebSocket from "ws";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";

/**
 * Teams end to end over the real socket, with the scripted agent calling the real `realm-team` tools
 * through the gateway: a role's run is a durable run, it delivers to Review, a person approves or asks
 * for changes, the dollar cap stops it, and a role's second wake queues behind its first.
 */

let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SLIDES = ["deck/01.png", "deck/02.png", "deck/03.png"];
const SUBMIT = {
  kind: "slideshows", title: "3 slideshows for Nathan", record: "nathan-beyenhof",
  items: [
    { files: SLIDES, body: "highlighting feels like studying. it isn't #ad", target: { channel: "TikTok", account: "@versed.nathan" } },
    { files: [SLIDES[1]], body: "second #ad", target: { channel: "TikTok", account: "@versed.nathan" } },
  ],
};

const SCRIPT: FakeScript = [
  { on: "asked for changes", emit: [
    { kind: "call", tool: "realm-team__review_submit", input: { ...SUBMIT, title: "3 slideshows for Nathan, v2" } },
    { kind: "text", text: "Revised and resubmitted." },
  ] },
  { on: "spend a lot", emit: [
    { kind: "usage", costUsd: 5 },
    { kind: "text", text: "still going", paceMs: 40 },
    { kind: "text", text: "and going", paceMs: 40 },
  ] },
  { on: "take your time", emit: [{ kind: "text", text: "one two three four five six seven eight", paceMs: 60 }] },
  { on: "keep the record", emit: [
    { kind: "call", tool: "realm-team__record_update", input: { op: "create", name: "Nathan Beyenhof" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Accounts", entry: "TikTok @versed.nathan · vault: tiktok.com/nathan · consent: contract §4" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Deal", entry: "Password: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" } },
    { kind: "text", text: "Record kept." },
  ] },
  { on: "no consent yet", emit: [
    { kind: "call", tool: "realm-team__record_update", input: { op: "create", name: "Nathan Beyenhof" } },
    { kind: "call", tool: "realm-team__record_update", input: { op: "add", path: "nathan-beyenhof", section: "Accounts", entry: "TikTok @versed.nathan · vault: tiktok.com/nathan" } },
    { kind: "text", text: "Record kept." },
  ] },
  { on: "make the slides", emit: [
    { kind: "call", tool: "realm-team__record_read", input: { path: "nathan-beyenhof" } },
    { kind: "usage", costUsd: 0.84 },
    { kind: "call", tool: "realm-team__review_submit", input: SUBMIT },
    { kind: "text", text: "Sent 2 slideshows to Review." },
  ] },
  { on: "outside the folder", emit: [
    { kind: "call", tool: "realm-team__review_submit", input: { kind: "report", title: "x", items: [{ files: ["/etc/hosts"] }] } },
    { kind: "text", text: "tried" },
  ] },
];

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>(); const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 8000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const must = async (method: string, params: unknown) => { const r = await call(method, params); if (!r.ok) throw new Error(`${method}: ${r.error?.message}`); return r.result; };
  return { call, must, events, close: () => ws.close() };
}

async function boot() {
  const home = tempDir("realm-team-");
  const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
  app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, agentRun: { fallbackKind: "fake" } });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Versed", icon: "folder" });
  mkdirSync(join(space.folderPath, "deck"), { recursive: true });
  SLIDES.forEach((f, i) => writeFileSync(join(space.folderPath, f), `png-${i}`));
  const c = await client(app.port);
  await c.must("team.make", { spaceId: space.id, templates: [] });
  const role = await c.must("team.roleCreate", { spaceId: space.id, name: "Content Producer", brief: "Make slides for each creator.", realmite: { seed: "cp" }, agentKind: "fake" });
  return { c, spaceId: space.id, folder: space.folderPath, roleId: role.id as string };
}

const runsOf = async (c: Any, roleId: string) => (await c.must("team.roleRuns", { id: roleId, limit: 20 })) as Any[];
const settled = (r: Any) => !["queued", "running", "blocked"].includes(r.state);

async function keepRecord(c: Any, roleId: string) {
  await c.must("team.roleRun", { id: roleId, message: "keep the record" });
  await waitFor(async () => (await runsOf(c, roleId)).every(settled), { timeout: 8000 });
}

describe("teams over the wire", () => {
  it("makes a team with its own memory repo, and starter roles once each", async () => {
    const { c, spaceId } = await boot();
    const team = await c.must("team.make", { spaceId, templates: ["creator-manager", "content-producer"] });
    // "Content Producer" already existed by that name, so only Creator Manager was added.
    expect(team.roles.map((r: Any) => r.name)).toEqual(["Content Producer", "Creator Manager"]);
    expect(team.hasRepo).toBe(true);
    const again = await c.must("team.make", { spaceId, templates: ["creator-manager"] });
    expect(again.roles).toHaveLength(2);
    const cm = again.roles.find((r: Any) => r.name === "Creator Manager");
    // The starter's clock is an ordinary schedule tagged with the role, on Sonnet, weekdays at 9.
    expect(cm).toMatchObject({ cron: "0 9 * * 1-5", model: "sonnet", runCapUsd: 3, runCapMs: 1_200_000, scheduleEnabled: true });
    const schedules = await c.must("schedules.list", { spaceId });
    expect(schedules.find((s: Any) => s.roleId === cm.id)).toMatchObject({ title: "Creator Manager", cron: "0 9 * * 1-5" });
    expect((await c.must("team.overview", {})).map((t: Any) => t.spaceId)).toEqual([spaceId]);
    c.close();
  });

  it("a role keeps a record: stamped lines, committed under its name, and a secret's shape refused", async () => {
    const { c, spaceId, roleId } = await boot();
    await keepRecord(c, roleId);
    const rec = await c.must("team.record", { spaceId, path: "nathan-beyenhof" });
    expect(rec.name).toBe("Nathan Beyenhof");
    expect(rec.markdown).toMatch(/## Accounts\n- TikTok @versed\.nathan · vault: tiktok\.com\/nathan · consent: contract §4 \[source: realm:session\/[0-9A-Z]{26}; added: \d{4}-\d{2}-\d{2}\]/);
    // The password line never landed.
    expect(rec.markdown).not.toContain("sk-ant");
    expect(rec.lastAuthor).toBe("Content Producer");
    const verbs = (await c.must("team.activity", { spaceId, limit: 50 })).map((a: Any) => a.verb);
    expect(verbs.filter((v: string) => v === "updated_record")).toHaveLength(2);
    // The feed's detail is the fact alone — no bullet, no provenance tail (the mutant logs the raw line).
    const lines = (await c.must("team.activity", { spaceId, limit: 50 })).filter((a: Any) => a.verb === "updated_record" && a.detail.line).map((a: Any) => a.detail.line);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) { expect(l).not.toMatch(/^\s*-\s/); expect(l).not.toContain("[source:"); }
    c.close();
  });

  it("Run now → the role submits a batch to Review: waiting, its cost on the run, a line in the log", async () => {
    const { c, spaceId, roleId } = await boot();
    await keepRecord(c, roleId);
    const run = await c.must("team.roleRun", { id: roleId, message: "make the slides" });
    expect(run).toMatchObject({ roleId, wokeOn: "manual", title: "Content Producer" });
    await waitFor(async () => (await c.must("team.space", { spaceId })).reviews.length === 1, { timeout: 8000 });
    await waitFor(async () => (await runsOf(c, roleId)).every(settled), { timeout: 8000 });
    const team = await c.must("team.space", { spaceId });
    const review = team.reviews[0];
    expect(review).toMatchObject({ title: "3 slideshows for Nathan", state: "waiting", kind: "slideshows", itemCount: 2, thumb: "deck/01.png",
      roleName: "Content Producer", recordPath: "creators/nathan-beyenhof.md", channels: ["TikTok"], account: "@versed.nathan" });
    expect(team.runSessionIds).toContain(run.id ? (await runsOf(c, roleId))[0].sessionId : "");
    const detail = await c.must("team.review", { id: review.id });
    expect(detail.items.map((i: Any) => i.files)).toEqual([SLIDES, [SLIDES[1]]]);
    expect(detail.costUsd).toBeCloseTo(0.84, 4);
    expect(detail.recordName).toBe("Nathan Beyenhof");
    expect(detail.checks[0]).toMatchObject({ ok: true, title: "Posts as @versed.nathan on TikTok" });
    expect(detail.checks[1]).toMatchObject({ ok: true, title: "Disclosed as paid partnership" });
    expect(detail.ledger.map((l: Any) => l.text)).toEqual(["Started by you", "Read Nathan Beyenhof", "Laid out 3 slides", "Sent 2 items to Review"]);
    const runs = await runsOf(c, roleId);
    expect(runs[0]).toMatchObject({ state: "succeeded", reviewId: review.id, reviewState: "waiting", summary: "Sent 2 slideshows to Review." });
    expect(runs[0].costUsd).toBeCloseTo(0.84, 4);
    c.close();
  });

  it("refuses a file outside the space's folder, and an account with no consent on record", async () => {
    const { c, spaceId, roleId } = await boot();
    await c.must("team.roleRun", { id: roleId, message: "outside the folder" });
    await waitFor(async () => (await runsOf(c, roleId)).every(settled), { timeout: 8000 });
    // No record at all yet: the account target has nothing to stand on either.
    await c.must("team.roleRun", { id: roleId, message: "make the slides" });
    await waitFor(async () => (await runsOf(c, roleId)).every(settled), { timeout: 8000 });
    expect((await c.must("team.space", { spaceId })).reviews).toEqual([]);
    const refusals = (await c.must("team.activity", { spaceId, limit: 50 })).filter((a: Any) => a.verb === "submitted");
    expect(refusals).toEqual([]);
    c.close();
  });

  it("refuses an account whose record line says no consent:, and names what to add", async () => {
    const { c, spaceId, roleId } = await boot();
    await c.must("team.roleRun", { id: roleId, message: "no consent yet" });
    await waitFor(async () => (await runsOf(c, roleId)).every(settled), { timeout: 8000 });
    await c.must("team.roleRun", { id: roleId, message: "make the slides" });
    await waitFor(async () => (await runsOf(c, roleId)).every(settled), { timeout: 8000 });
    expect((await c.must("team.space", { spaceId })).reviews).toEqual([]);
    const sid = (await runsOf(c, roleId))[0].sessionId;
    const results = app.sessions.events(sid, 0, 500).filter((e) => e.event.type === "tool_result").map((e) => JSON.stringify(e.event.payload));
    expect(results.some((r) => r.includes("without consent:"))).toBe(true);
    c.close();
  });

  it("approve issues one paced ticket per post, and the ticket refuses an RPC call nobody pressed a sheet for", async () => {
    const { c, spaceId, roleId, folder } = await boot();
    await keepRecord(c, roleId);
    await c.must("team.roleRun", { id: roleId, message: "make the slides" });
    await waitFor(async () => (await c.must("team.space", { spaceId })).reviews.length === 1, { timeout: 8000 });
    const id = (await c.must("team.space", { spaceId })).reviews[0].id;
    await c.must("team.reviewApprove", { id });
    const detail = await c.must("team.review", { id });
    expect(detail.tickets).toHaveLength(2);
    expect(detail.tickets.map((t: Any) => t.contentHash)).toEqual(detail.items.map((i: Any) => i.approvedHash));
    expect(detail.tickets[1].slotAt - detail.tickets[0].slotAt).toBeGreaterThanOrEqual(2 * 60 * 60_000);
    expect(detail.tickets[0]).toMatchObject({ state: "ready", consent: "contract §4", signin: "tiktok.com/nathan", adapter: { connected: false } });
    // An agent with the daemon's token calls the method straight: no press from main, so nothing goes.
    const r = await c.call("team.ticketPost", { id: detail.tickets[0].id });
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/Only a person's click/);
    expect((await c.must("team.tickets", { spaceId })).every((t: Any) => t.state === "ready")).toBe(true);
    expect((await c.must("team.activity", { spaceId, limit: 50 })).some((a: Any) => a.verb === "refused" && a.detail.why === "no_press")).toBe(true);
    // A file changed after the yes takes the tickets back with the batch.
    writeFileSync(join(folder, SLIDES[1]!), "png-edited");
    await c.must("team.space", { spaceId });
    expect(await c.must("team.tickets", { spaceId })).toEqual([]);
    c.close();
  });

  it("approve records the hash; a file changed afterwards drops the batch back to waiting", async () => {
    const { c, spaceId, roleId, folder } = await boot();
    await keepRecord(c, roleId);
    await c.must("team.roleRun", { id: roleId, message: "make the slides" });
    await waitFor(async () => (await c.must("team.space", { spaceId })).reviews.length === 1, { timeout: 8000 });
    const id = (await c.must("team.space", { spaceId })).reviews[0].id;
    const approved = await c.must("team.reviewApprove", { id });
    expect(approved.state).toBe("approved");
    const after = await c.must("team.review", { id });
    expect(after.items.every((i: Any) => i.approvedHash === i.contentHash && i.actState === "ready")).toBe(true);
    const log = await c.must("team.activity", { spaceId, limit: 50 });
    expect(log.find((a: Any) => a.verb === "approved")).toMatchObject({ actor: "user", object: "3 slideshows for Nathan" });
    // Nothing went out: Phase 1 has no act, so no item moved past `ready`.
    writeFileSync(join(folder, SLIDES[1]!), "png-edited");
    const reread = (await c.must("team.space", { spaceId })).reviews[0];
    expect(reread).toMatchObject({ state: "waiting", changedSinceApproval: true });
    expect(reread.note).toMatch(/changed after you approved/);
    c.close();
  });

  it("request changes wakes the run that made it, in its session, and the revision replaces the batch in place", async () => {
    const { c, spaceId, roleId } = await boot();
    await keepRecord(c, roleId);
    await c.must("team.roleRun", { id: roleId, message: "make the slides" });
    await waitFor(async () => (await runsOf(c, roleId)).every(settled) && (await c.must("team.space", { spaceId })).reviews.length === 1, { timeout: 8000 });
    const id = (await c.must("team.space", { spaceId })).reviews[0].id;
    const first = (await runsOf(c, roleId))[0];
    const asked = await c.must("team.reviewRequestChanges", { id, note: "Make the hook shorter." });
    expect(asked).toMatchObject({ state: "changes", note: "Make the hook shorter." });
    await waitFor(async () => (await c.must("team.review", { id })).version === 2, { timeout: 8000 });
    const runs = await runsOf(c, roleId);
    expect(runs[0]).toMatchObject({ wokeOn: "review", wokeNote: "Make the hook shorter.", sessionId: first.sessionId });
    const v2 = await c.must("team.review", { id });
    expect(v2).toMatchObject({ state: "waiting", version: 2, title: "3 slideshows for Nathan, v2" });
    expect(v2.previous).toHaveLength(2);
    // The ledger names the version it sent, in a sentence — the mutant read "Sent version 2 2 items to Review".
    expect(v2.ledger.map((l: Any) => l.text)).toContain("Sent version 2 to Review");
    expect((await c.must("team.space", { spaceId })).reviews).toHaveLength(1);
    // The note reached the session as the run's message.
    const ev = app.sessions.events(first.sessionId, 0, 500).filter((e) => e.event.type === "user_message");
    expect(JSON.stringify(ev.at(-1)!.event.payload)).toContain("Make the hook shorter.");
    c.close();
  });

  it("a run stops at its dollar cap: cancelled with the reason, and a line saying which cap", async () => {
    const { c, spaceId, roleId } = await boot();
    await c.must("team.roleRun", { id: roleId, message: "spend a lot" });
    await waitFor(async () => (await runsOf(c, roleId)).every(settled), { timeout: 8000 });
    const [run] = await runsOf(c, roleId);
    expect(run).toMatchObject({ state: "cancelled", stoppedAtCap: "usd", error: "Content Producer stopped at its $3 run limit" });
    expect(run.costUsd).toBe(5);
    const log = await c.must("team.activity", { spaceId, limit: 50 });
    expect(log.find((a: Any) => a.verb === "stopped_at_cap")).toMatchObject({ actor: "realm", detail: expect.objectContaining({ cap: "usd" }) });
    c.close();
  });

  it("the role's clock fires a run as the role, with its constraints — and stands down once its week's budget is spent", async () => {
    const { c, spaceId, roleId } = await boot();
    await c.must("team.roleUpdate", { id: roleId, cron: "0 9 * * 1-5", model: "fake-model", permissionMode: "acceptEdits" });
    const sched = (await c.must("schedules.list", { spaceId })).find((x: Any) => x.roleId === roleId);
    await c.must("schedules.runNow", { id: sched.id });
    await waitFor(async () => (await runsOf(c, roleId)).length === 1);
    const run = (await c.must("runs.list", { spaceId })).runs[0];
    expect(run).toMatchObject({ roleId, wokeOn: "schedule", scheduleId: sched.id, title: "Content Producer",
      constraints: { agentKind: "fake", model: "fake-model", permissionMode: "acceptEdits" } });
    await waitFor(async () => (await runsOf(c, roleId)).every(settled), { timeout: 8000 });
    // A week's budget smaller than what was just spent: the next firing is skipped and said.
    await c.must("team.roleUpdate", { id: roleId, weekBudgetUsd: 0.0001 });
    expect((await c.must("team.space", { spaceId })).roles[0]).toMatchObject({ state: "paused", pausedWhy: "Content Producer has spent its $0.00 for this week" });
    await c.must("schedules.runNow", { id: sched.id });
    expect(await runsOf(c, roleId)).toHaveLength(1);
    expect((await c.must("schedules.list", { spaceId })).find((x: Any) => x.id === sched.id).lastSkippedAt).not.toBeNull();
    expect((await c.must("team.activity", { spaceId, limit: 50 })).some((a: Any) => a.verb === "paused")).toBe(true);
    c.close();
  });

  it("a role's second wake queues behind its first, and starts when the first settles", async () => {
    const { c, roleId } = await boot();
    const a = await c.must("team.roleRun", { id: roleId, message: "take your time" });
    const b = await c.must("team.roleRun", { id: roleId, message: "take your time" });
    await waitFor(async () => (await runsOf(c, roleId)).find((r) => r.id === a.id)?.state === "running");
    expect((await runsOf(c, roleId)).find((r) => r.id === b.id)?.state).toBe("queued");
    expect((await c.must("team.space", { spaceId: a.spaceId })).roles[0].state).toBe("working");
    await waitFor(async () => (await runsOf(c, roleId)).every(settled), { timeout: 10_000 });
    const runs = await runsOf(c, roleId);
    const ra = runs.find((r) => r.id === a.id)!, rb = runs.find((r) => r.id === b.id)!;
    expect(rb.state).toBe("succeeded");
    expect(rb.startedAt).toBeGreaterThanOrEqual(ra.settledAt);
    c.close();
  });

  it("the role's preamble names the team's rules and its cap, and its brief edits reach the schedule", async () => {
    const { c, spaceId, roleId } = await boot();
    const r = await c.must("team.roleUpdate", { id: roleId, cron: "0 9 * * 1,4", brief: "Make slides for Nathan only." });
    expect(r.cron).toBe("0 9 * * 1,4");
    const s = (await c.must("schedules.list", { spaceId })).find((x: Any) => x.roleId === roleId);
    expect(s.goal).toContain("Make slides for Nathan only.");
    const run = await c.must("team.roleRun", { id: roleId, message: "take your time" });
    await waitFor(async () => (await runsOf(c, roleId))[0].sessionId !== null);
    const sid = (await runsOf(c, roleId))[0].sessionId;
    const pre = app.runs.extraSystemContext(sid)!;
    expect(pre).toContain("You are Content Producer");
    expect(pre).toContain("review_submit");
    expect(pre).toContain("stops at $3 or 20 minutes");
    void run;
    c.close();
  });
});

describe("records' git author", () => {
  it("is the role's name, read back from the repo", async () => {
    const { c, roleId } = await boot();
    await keepRecord(c, roleId);
    const repo = app.team.repoPath((await c.must("team.overview", {}))[0].spaceId)!;
    const author = execFileSync("git", ["-C", repo, "log", "-1", "--format=%an", "--", "creators/nathan-beyenhof.md"], { encoding: "utf8" }).trim();
    expect(author).toBe("Content Producer");
    expect(readFileSync(join(repo, "MEMORY.md"), "utf8")).toContain("[[creators/nathan-beyenhof]]");
    c.close();
  });
});

describe("choosing who is on the team", () => {
  it("makes starters and the person's own teammates in one go, each with its own Realmite, and shows the shares", async () => {
    const { c, spaceId } = await boot();
    const team = await c.must("team.make", {
      spaceId, templates: ["researcher", "editor"],
      roles: [{ name: "Podcast Booker", brief: "Find guests and draft the pitch to each.", realmite: { seed: "booker-1" }, model: "haiku", cron: null, weekBudgetUsd: 8, permissionMode: "plan", skills: [] }],
    });
    const names = team.roles.map((r: Any) => r.name);
    expect(names).toEqual(["Content Producer", "Researcher", "Editor", "Podcast Booker"]);
    const booker = team.roles.find((r: Any) => r.name === "Podcast Booker");
    expect(booker).toMatchObject({ model: "haiku", permissionMode: "plan", cron: null, weekBudgetUsd: 8, realmite: { seed: "booker-1" } });
    // Researcher $10 + Editor $5 + the booker's $8; Content Producer has no share of its own.
    expect(team.sharesUsd).toBe(23);
    expect(new Set(team.roles.map((r: Any) => JSON.stringify(r.realmite))).size).toBe(4);
    c.close();
  });

  it("keeps the shares within the team's week: over is refused with nothing made, and raising the week makes room", async () => {
    const { c, spaceId } = await boot();
    const every = ["researcher", "editor", "growth-analyst", "community-manager", "ops", "creator-manager", "content-producer"];
    // Content Producer is already on the team, so the six others come to $60 — and one more $5 is over.
    const over = await c.call("team.make", { spaceId, templates: every, roles: [{ name: "Intern", brief: "Help.", realmite: { seed: "i" }, weekBudgetUsd: 5 }] });
    expect(over.error.code).toBe("TEAM_BUDGET_OVER");
    expect(over.error.message).toMatch(/\$65 of the team's \$60 a week/);
    expect((await c.must("team.space", { spaceId })).roles).toHaveLength(1);
    const raised = await c.must("team.make", { spaceId, templates: every, roles: [{ name: "Intern", brief: "Help.", realmite: { seed: "i" }, weekBudgetUsd: 5 }], weekBudgetUsd: 65 });
    expect(raised).toMatchObject({ weekBudgetUsd: 65, sharesUsd: 65 });
    // A role's share raised past the week is refused; lowered, it is taken.
    const intern = raised.roles.find((r: Any) => r.name === "Intern");
    expect((await c.call("team.roleUpdate", { id: intern.id, weekBudgetUsd: 6 })).error.code).toBe("TEAM_BUDGET_OVER");
    expect((await c.must("team.roleUpdate", { id: intern.id, weekBudgetUsd: 2 })).weekBudgetUsd).toBe(2);
    expect((await c.call("team.roleCreate", { spaceId, name: "Second intern", brief: "Help.", realmite: { seed: "j" }, weekBudgetUsd: 4 })).error.code).toBe("TEAM_BUDGET_OVER");
    // The week cannot go under what the shares already come to.
    expect((await c.call("team.setBudget", { spaceId, weekBudgetUsd: 50 })).error.code).toBe("TEAM_BUDGET_OVER");
    expect((await c.must("team.setBudget", { spaceId, weekBudgetUsd: 100 })).weekBudgetUsd).toBe(100);
    c.close();
  });

  it("refuses two new teammates with one name before making either", async () => {
    const { c, spaceId } = await boot();
    const r = await c.call("team.make", { spaceId, templates: ["editor"], roles: [{ name: "editor", brief: "x", realmite: { seed: "e" } }] });
    expect(r.error.code).toBe("TEAM_ROLE_NAME");
    expect((await c.must("team.space", { spaceId })).roles).toHaveLength(1);
    c.close();
  });

  it("a removed role stops waking, keeps its history under its name, and its name is free again", async () => {
    const { c, spaceId } = await boot();
    const team = await c.must("team.make", { spaceId, templates: ["editor"] });
    const editor = team.roles.find((r: Any) => r.name === "Editor");
    await c.must("team.roleArchive", { id: editor.id });
    const after = await c.must("team.space", { spaceId });
    expect(after.roles.map((r: Any) => r.name)).toEqual(["Content Producer"]);
    expect(after.formerRoles).toEqual([{ id: editor.id, name: "Editor", realmite: { seed: "editor-77" } }]);
    expect((await c.must("schedules.list", { spaceId })).some((s: Any) => s.roleId === editor.id)).toBe(false);
    const log = await c.must("team.activity", { spaceId, limit: 50 });
    expect(log.map((a: Any) => a.verb)).toEqual(expect.arrayContaining(["made_role", "archived_role"]));
    const again = await c.must("team.make", { spaceId, templates: ["editor"] });
    expect(again.roles.map((r: Any) => r.name)).toEqual(["Content Producer", "Editor"]);
    c.close();
  });
});

describe("a team's memory repo when Realm's home is inside a space's folder", () => {
  async function bootInside(fallback: string | undefined) {
    const outer = tempDir("realm-team-projects-");
    const home = join(outer, "preview-home");
    mkdirSync(home, { recursive: true });
    const fake = new FakeAdapter({ script: SCRIPT, delayMs: 2 });
    app = await createApp({ home, port: 0, adapters: { fake, claude: fake }, ...(fallback ? { memoryFallbackRoot: fallback } : {}) });
    const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
    const projects = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Projects", icon: "folder" });
    app.db.prepare("UPDATE spaces SET folder_path = ? WHERE id = ?").run(outer, projects.id);
    const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "Versed", icon: "folder" });
    return { c: await client(app.port), spaceId: space.id, home };
  }

  it("goes to the fallback folder, and the team says where", async () => {
    const fallback = join(tempDir("realm-team-fallback-"), "memory-repos");
    const { c, spaceId, home } = await bootInside(fallback);
    // THE MUTANT: no fallback — the default under the home is refused and the team is never made.
    const team = await c.must("team.make", { spaceId, templates: ["editor"] });
    expect(team).toMatchObject({ hasRepo: true, repoMoved: true });
    expect(team.repoPath).toBe(join(fallback, `space-${spaceId}`));
    expect(team.repoPath.startsWith(home)).toBe(false);
    c.close();
  });

  it("with nowhere allowed, says so in plain words, and a chosen folder makes it", async () => {
    const { c, spaceId } = await bootInside(undefined);
    const r = await c.call("team.make", { spaceId, templates: ["editor"] });
    expect(r.error.code).toBe("MEMORY_REPO_FORBIDDEN");
    expect(r.error.message).toMatch(/Choose a folder outside your projects/);
    expect((await c.must("team.space", { spaceId })).enabled).toBe(false);
    const chosen = join(tempDir("realm-team-chosen-"), "versed-memory");
    const team = await c.must("team.make", { spaceId, templates: ["editor"], repoPath: chosen });
    expect(team).toMatchObject({ hasRepo: true, repoPath: chosen, repoMoved: true });
    c.close();
  });
});
