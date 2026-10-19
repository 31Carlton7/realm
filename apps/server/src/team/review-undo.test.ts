import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { parseRecord } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { TeamStore } from "./store";
import { TeamService } from "./service";
import { RecordTypeStore } from "./record-types/store";
import { RecordTypeService } from "./record-types/service";
import { ActStore } from "./acts/store";
import { ActService, type TicketPress } from "./acts/service";
import type { ActAdapter, ActRequest, ActResult } from "./acts/adapters";

/**
 * Undo after Approve: the yes is taken back while nothing of it has left Realm, and refused once
 * anything has. The real act service sits under the team, so a ticket that went out, is going out or
 * was handed over is the one the platform saw. Each test names the one-line mutant it kills.
 */

const RECORD = ["# Nathan Beyenhof", "", "## Accounts", "- TikTok @versed.nathan · vault: tiktok.com/nathan · consent: contract §4", ""].join("\n");
/** Friday 9 October 2026, 2:00 PM local — inside the hours a post may go out. */
const T0 = new Date(2026, 9, 9, 14, 0, 0, 0).getTime();

class Platform implements ActAdapter {
  calls: ActRequest[] = [];
  fail = false;
  /** Set, the act waits on it: the ticket is `acting` until the test lets it go. */
  hold: Promise<void> | null = null;
  status() { return { connected: true, label: "Fake", why: null }; }
  async act(req: ActRequest): Promise<ActResult> {
    this.calls.push(req);
    if (this.hold) await this.hold;
    writeFileSync(req.screenshotPath, "png");
    return this.fail ? { ok: false, error: "the platform said no", screenshot: req.screenshotPath } : { ok: true, url: `https://fake.invalid/${req.ticketId}`, screenshot: req.screenshotPath };
  }
}

function setup() {
  const home = tempDir("realm-review-undo-");
  const db = openDatabase(join(home, "realm.db"));
  db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES ('p', 'P', 'x', '#000', 0, 1, 1)").run();
  const folder = join(home, "space");
  mkdirSync(join(folder, "deck"), { recursive: true });
  db.prepare("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at) VALUES ('S1', 'p', 'Versed', 'f', 0, ?, 1, 1)").run(folder);
  let now = T0;
  const clock = () => now;
  const store = new TeamStore(db, clock);
  const actStore = new ActStore(db, clock);
  const platform = new Platform();
  const pressed = new Set<string>();
  const presses = {
    consume: async (ticketId: string): Promise<TicketPress> => {
      const yes = pressed.delete(ticketId);
      return { pressed: yes, label: false, slotAt: yes ? actStore.ticket(ticketId)!.slotAt : null };
    },
  };
  const broadcasts: unknown[] = [];
  const rpc = { broadcast: (m: string, p: unknown) => { broadcasts.push([m, p]); } };
  const acts = new ActService({ store: actStore, team: store, rootForSpace: () => folder, record: () => parseRecord(RECORD), presses,
    adapter: () => platform, proofDir: join(home, "proof"), rpc: rpc as never, clock });
  const recordTypes = new RecordTypeService({ store: new RecordTypeStore(db), repoPath: () => null, spaceExists: () => true, log: () => {}, changed: () => {} });
  const team = new TeamService({
    store, recordTypes, acts,
    runs: { get: () => null, listLive: () => [], spentSince: () => 0 } as never,
    schedules: {} as never, sessions: { publishServerEvent: () => {} } as never, repos: { config: () => null } as never,
    rootForSpace: () => folder, spaceExists: () => true, settings: { get: () => undefined, set: () => {} }, rpc, clock,
  });
  /** Two slideshows aimed at the account, waiting for the person — as a role would send them. */
  const batch = () => {
    const items = [1, 2].map((n) => {
      const files = [`deck/${n}-a.png`, `deck/${n}-b.png`];
      for (const f of files) writeFileSync(join(folder, f), `bytes of ${f}`);
      const body = `slideshow ${n} #ad`;
      return { files, body, target: { channel: "TikTok", account: "@versed.nathan" }, contentHash: team.hashItem(folder, files, body) };
    });
    return store.createReview({ spaceId: "S1", roleId: null, runId: null, sessionId: null, recordPath: "creators/nathan.md", kind: "slideshows", title: "2 slideshows for Nathan" }, items);
  };
  /** The person's click on a ticket's sheet, then the press itself. */
  const post = async (ticketId: string) => { pressed.add(ticketId); await acts.post(ticketId); };
  const verbs = () => store.activity("S1", 500).map((a) => a.verb).reverse();
  return { store, acts, team, platform, folder, broadcasts, batch, post, verbs, setNow: (t: number) => { now = t; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("undoing an approval", () => {
  it("puts the same draft back to waiting — its files and hashes as they were — and takes back every ticket, a pressed one too", async () => {
    const { store, acts, team, platform, broadcasts, batch, post, verbs, setNow } = setup();
    const r = batch();
    const before = store.items(r.id, 1);
    team.approve(r.id);
    const [first, second] = acts.tickets(r.id);
    // The second is set for its slot two hours on: pressed, and nothing has gone out.
    await post(second!.id);
    expect(acts.ticket(second!.id).state).toBe("scheduled");
    broadcasts.length = 0;

    const back = team.undoApproval(r.id);
    expect(back).toMatchObject({ state: "waiting", version: 1, decidedAt: null, changedSinceApproval: false, actsTotal: 0 });
    // The same items, the same bytes: nothing about the draft moved but the yes.
    const after = store.items(r.id, 1);
    expect(after.map((i) => [i.id, i.contentHash])).toEqual(before.map((i) => [i.id, i.contentHash]));
    // THE MUTANT: the approved hash left on the items — the yes half-kept, and a file changed while it
    // waits reads "changed after you approved it" with nothing approved.
    expect(after.every((i) => i.approvedHash === null && i.actState === "none")).toBe(true);
    // THE MUTANT: the tickets left standing — the press set for 4 PM would still go at 4 PM.
    expect(acts.tickets(r.id)).toEqual([]);
    expect(acts.ticket(first!.id).state).toBe("cancelled");
    setNow(second!.slotAt + 1_000);
    await acts.execute(second!.id);
    expect(platform.calls).toEqual([]);
    // THE MUTANT: no activity line — the log says it was approved and never that it no longer is.
    expect(store.activity("S1", 10).find((a) => a.verb === "undid_approval")).toMatchObject({ actor: "user", object: "2 slideshows for Nathan", detail: { reviewId: r.id, version: 1 } });
    expect(verbs().slice(-3)).toEqual(["undid_approval", "cancelled_ticket", "cancelled_ticket"]);
    // The window re-reads the team on this, which is what folds the row back into Waiting for you.
    expect(broadcasts).toContainEqual(["team.changed", { spaceId: "S1" }]);
    expect(store.waiting().map((w) => w.id)).toEqual([r.id]);
  });

  it("re-pins on the next yes: a file changed while it waited is what the new approval covers, with tickets for the new bytes", () => {
    const { store, acts, team, folder, batch } = setup();
    const r = batch();
    team.approve(r.id);
    const old = acts.tickets(r.id).map((t) => t.contentHash);
    team.undoApproval(r.id);
    writeFileSync(join(folder, "deck/1-a.png"), "a better first slide");
    // Read while waiting: the hash moves with the file, and nothing claims an approval was broken.
    expect(team.review(r.id)).toMatchObject({ state: "waiting", changedSinceApproval: false, note: null });
    const edited = store.items(r.id, 1)[0]!;
    team.approve(r.id);
    const pinned = store.items(r.id, 1);
    // THE MUTANT: approving pins only what had no hash yet (`COALESCE(approved_hash, …)`) — with the
    // old hash kept by the undo, the yes would cover bytes nobody looked at this time.
    expect(pinned[0]!.approvedHash).toBe(edited.contentHash);
    expect(pinned.every((i) => i.approvedHash === i.contentHash)).toBe(true);
    const tickets = acts.tickets(r.id);
    expect(tickets.map((t) => t.contentHash)).toEqual(pinned.map((i) => i.approvedHash));
    expect(tickets[0]!.contentHash).not.toBe(old[0]);
    expect(tickets.every((t) => t.state === "ready")).toBe(true);
  });

  it("is idempotent: a second Undo changes nothing and writes nothing", () => {
    const { store, team, batch } = setup();
    const r = batch();
    team.approve(r.id);
    team.undoApproval(r.id);
    const once = store.review(r.id);
    // THE MUTANT: a second Undo refused as "not approved", or logged again — a double click on the
    // toast's button would read as a failure, or say twice that one thing happened.
    expect(team.undoApproval(r.id)).toMatchObject({ state: "waiting" });
    expect(store.review(r.id)).toEqual(once);
    expect(store.activity("S1", 50).filter((a) => a.verb === "undid_approval")).toHaveLength(1);
  });

  it("refuses once a post went out, and the batch stays approved with what is left still to press", async () => {
    const { store, acts, team, batch, post } = setup();
    const r = batch();
    team.approve(r.id);
    const [first, second] = acts.tickets(r.id);
    await post(first!.id);
    await flush();
    expect(acts.ticket(first!.id).state).toBe("done");
    // THE MUTANT: the went-out check dropped — the yes would be taken back from a post already on TikTok.
    expect(() => team.undoApproval(r.id)).toThrow(/^It's too late to undo: a post already went out\. Close stops whatever hasn't gone out\.$/);
    expect(store.review(r.id)!.state).toBe("approved");
    expect(store.items(r.id, 1).every((i) => i.approvedHash === i.contentHash)).toBe(true);
    expect(acts.ticket(second!.id).state).toBe("ready");
    expect(store.activity("S1", 50).some((a) => a.verb === "undid_approval")).toBe(false);
  });

  it("refuses while a post is going out, and once one was handed over and came back with an error", async () => {
    const { store, acts, team, platform, batch, post } = setup();
    const r = batch();
    team.approve(r.id);
    const [first] = acts.tickets(r.id);
    let release!: () => void;
    platform.hold = new Promise((res) => { release = res; });
    platform.fail = true;
    await post(first!.id);
    expect(acts.ticket(first!.id).state).toBe("acting");
    // THE MUTANT: only `done` counted — a post the platform is uploading this second would be "undone".
    expect(() => team.undoApproval(r.id)).toThrow(/a post is going out right now/);
    release();
    await flush(); await flush();
    // Back with an error and waiting for a press again, it may still have gone up: the platform says.
    expect(acts.ticket(first!.id)).toMatchObject({ state: "ready", error: "the platform said no" });
    // THE MUTANT: the ticket's state read alone — `ready` again, it looks like nothing ever left.
    expect(() => team.undoApproval(r.id)).toThrow(/a post was already handed to TikTok/);
    expect(store.review(r.id)!.state).toBe("approved");
  });

  it("refuses what is not an approval: a rejected, closed or finished batch is not put back", () => {
    const { store, team, batch } = setup();
    const closed = batch();
    team.closeReview(closed.id);
    // THE MUTANT: no state check — Undo reopening a batch the person closed or rejected.
    expect(() => team.undoApproval(closed.id)).toThrow(/closed by the person, so there is no approval to undo/);
    const done = batch();
    team.approve(done.id);
    team.markDone(done.id);
    expect(() => team.undoApproval(done.id)).toThrow(/done, so there is no approval to undo/);
    expect(store.review(done.id)!.state).toBe("done");
  });
});
