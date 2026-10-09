import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { ACT_PACING, parseRecord, type ActKind, type ReviewKind, type ReviewTarget } from "@realm/contracts";
import { openDatabase } from "../../db/database";
import { TeamStore } from "../store";
import { bytesHash, itemHash } from "../item-hash";
import { ActStore } from "./store";
import { ActService, type TicketPress } from "./service";
import type { ActAdapter, ActRequest, ActResult } from "./adapters";

/**
 * Approve → act, with a fake clock, a fake platform and a stand-in for main's press. Each test names
 * the one-line mutant it kills.
 */

const RECORD = [
  "# Nathan Beyenhof",
  "- Status: signed",
  "",
  "## Accounts",
  "- TikTok @versed.nathan · vault: tiktok.com/nathan · device: lab-iphone-2 · consent: contract §4",
  "- Instagram @versed.nathan · vault: instagram.com/nathan · device: lab-iphone-2",
  "",
].join("\n");

/** Friday 9 October 2026, 2:00 PM local. */
const T0 = new Date(2026, 9, 9, 14, 0, 0, 0).getTime();
const H = 60 * 60_000;

class Platform implements ActAdapter {
  calls: ActRequest[] = [];
  connected = true;
  fail = false;
  status() { return { connected: this.connected, label: "Fake", why: this.connected ? null : "not connected" }; }
  async act(req: ActRequest): Promise<ActResult> {
    this.calls.push(req);
    writeFileSync(req.screenshotPath, "png");
    return this.fail ? { ok: false, error: "the platform said no", screenshot: req.screenshotPath } : { ok: true, url: `https://fake.invalid/${req.ticketId}`, screenshot: req.screenshotPath };
  }
}

function setup(o: { record?: string } = {}) {
  const home = tempDir("realm-acts-");
  const db = openDatabase(join(home, "realm.db"));
  db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES ('p', 'P', 'x', '#000', 0, 1, 1)").run();
  const folder = join(home, "space");
  mkdirSync(join(folder, "deck"), { recursive: true });
  db.prepare("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at) VALUES ('S1', 'p', 'Versed', 'f', 0, ?, 1, 1)").run(folder);
  let now = T0;
  const clock = () => now;
  const team = new TeamStore(db, clock);
  const store = new ActStore(db, clock);
  const platform = new Platform();
  let record = o.record ?? RECORD;
  /** What main would answer: pressed only when the test pressed, once. */
  const pressed = new Map<string, { label: boolean; slotAt: number | null }>();
  const presses = {
    consume: async (ticketId: string, contentHash: string): Promise<TicketPress> => {
      const p = pressed.get(ticketId); pressed.delete(ticketId);
      const t = store.ticket(ticketId);
      return p && t?.contentHash === contentHash ? { pressed: true, label: p.label, slotAt: p.slotAt } : { pressed: false, label: false, slotAt: null };
    },
  };
  const broadcasts: unknown[] = [];
  const acts = new ActService({
    store, team, rootForSpace: () => folder, record: () => parseRecord(record), presses,
    adapter: () => platform, proofDir: join(home, "proof"), rpc: { broadcast: (_e: string, p: unknown) => { broadcasts.push(p); } } as never, clock,
  });
  const hashOf = (files: string[], body: string | null) => itemHash(files, (f) => { const p = join(folder, f); return existsSync(p) ? bytesHash(readFileSync(p)) : "missing"; }, body);

  /** A batch as a role would send it, approved by the person. */
  const approved = (kind: ReviewKind, items: { files?: string[]; body: string; target: ReviewTarget }[]) => {
    items.forEach((it, i) => (it.files ?? []).forEach((f) => writeFileSync(join(folder, f), `bytes-${i}-${f}`)));
    const r = team.createReview({ spaceId: "S1", roleId: null, runId: null, sessionId: null, recordPath: "creators/nathan-beyenhof.md", kind, title: "batch" },
      items.map((it) => ({ files: it.files ?? [], body: it.body, target: it.target, contentHash: hashOf(it.files ?? [], it.body) })));
    team.approveItems(r.id, 1);
    team.setReviewState(r.id, "approved", { decided: true });
    return { review: r, tickets: acts.issue(r.id) };
  };
  /** The person's click on a ticket's sheet, as main records it. */
  const press = (id: string, o2: { label?: boolean; slotAt?: number } = {}) => {
    pressed.set(id, { label: o2.label ?? false, slotAt: o2.slotAt ?? acts.ticket(id).slotAt });
  };
  const verbs = () => team.activity("S1", 500).map((a) => a.verb).reverse();
  return {
    db, acts, store, team, platform, folder, press, approved, verbs, broadcasts,
    setNow: (t: number) => { now = t; }, setRecord: (r: string) => { record = r; },
  };
}

const slides = (n: number) => Array.from({ length: n }, (_, i) => ({
  files: [`deck/${i + 1}-a.png`, `deck/${i + 1}-b.png`], body: `slideshow ${i + 1} #ad`, target: { channel: "TikTok", account: "@versed.nathan" },
}));
const dms = (n: number) => Array.from({ length: n }, (_, i) => ({ body: `hi ${i + 1}`, target: { channel: "TikTok", account: "@versed.nathan", to: `@reader${i + 1}` } }));
const flush = () => new Promise((r) => setTimeout(r, 0));
const day = (t: number) => new Date(t).getDate();

describe("issuing tickets on a yes", () => {
  it("a 6-slideshow batch is six tickets, two hours apart, three a day — and nothing goes out", () => {
    const { approved, platform } = setup();
    const { tickets } = approved("slideshows", slides(6));
    expect(tickets).toHaveLength(6);
    const at = tickets.map((t) => t.slotAt).sort((a, b) => a - b);
    // THE MUTANTS: `gapMs` of 0 (all at 2 PM), or `perDay` unchecked (six on Friday, the last at midnight).
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(2 * H);
    expect(at.filter((t) => day(t) === 9)).toHaveLength(3);
    expect(at.map((t) => new Date(t).getHours())).toEqual([14, 16, 18, 8, 10, 12]);
    expect(tickets.every((t) => t.state === "ready" && t.kind === "post")).toBe(true);
    expect(platform.calls).toEqual([]);
  });

  it("is bound to the approved hash, and approving twice issues nothing new", () => {
    const { approved, acts, team } = setup();
    const { review, tickets } = approved("slideshows", slides(2));
    const items = team.items(review.id, 1);
    expect(tickets.map((t) => t.contentHash)).toEqual(items.map((i) => i.approvedHash));
    expect(acts.issue(review.id).map((t) => t.id)).toEqual(tickets.map((t) => t.id));
  });

  it("issues nothing for work aimed nowhere, and nothing for a DM that names nobody", () => {
    const { approved } = setup();
    expect(approved("report", [{ body: "a report", target: {} }]).tickets).toEqual([]);
    expect(approved("message", [{ body: "hi", target: { channel: "Instagram", account: "@versed.nathan" } }]).tickets).toEqual([]);
  });
});

describe("the press", () => {
  it("an agent cannot fire a ticket: without the person's press on its sheet, it is refused and nothing goes out", async () => {
    const { approved, acts, platform, verbs, store } = setup();
    const t = approved("slideshows", slides(1)).tickets[0]!;
    // THE MUTANT: skip `presses.consume` — anything holding the RPC token posts by calling the method.
    await expect(acts.post(t.id)).rejects.toMatchObject({ code: "TEAM_TICKET_NOT_PRESSED" });
    await flush();
    expect(platform.calls).toEqual([]);
    expect(store.ticket(t.id)!.state).toBe("ready");
    expect(verbs()).toContain("refused");
  });

  it("a press is for one ticket and one set of bytes, and is spent by the act", async () => {
    const { approved, acts, press, platform } = setup();
    const [a, b] = approved("slideshows", slides(2)).tickets;
    press(a!.id);
    await expect(acts.post(b!.id)).rejects.toMatchObject({ code: "TEAM_TICKET_NOT_PRESSED" });
    await acts.post(a!.id);
    await flush();
    expect(platform.calls.map((c) => c.ticketId)).toEqual([a!.id]);
    await expect(acts.post(a!.id)).rejects.toMatchObject({ code: "TEAM_TICKET_STATE" });
  });

  it("pressed in its slot, it goes out once, and keeps its URL and screenshot as proof, in the ticket and the log", async () => {
    const { approved, acts, press, platform, team } = setup();
    const t = approved("slideshows", slides(1)).tickets[0]!;
    press(t.id);
    await acts.post(t.id);
    await flush();
    const done = acts.ticket(t.id);
    expect(done).toMatchObject({ state: "done", proofUrl: `https://fake.invalid/${t.id}`, actedAt: T0 });
    expect(existsSync(done.screenshot!)).toBe(true);
    expect(platform.calls).toHaveLength(1);
    // The platform got the staged copies — the bytes that were hashed — not the space's originals.
    expect(platform.calls[0]!.files.every((f) => f.includes(t.id))).toBe(true);
    const acted = team.activity("S1", 50).find((a) => a.verb === "acted")!;
    expect(acted.detail).toMatchObject({ url: done.proofUrl, screenshot: done.screenshot, hash: t.contentHash });
    // The one ticket of the batch went out, so the batch is done.
    expect(team.review(t.reviewId)!.state).toBe("done");
  });

  it("pressed ahead of its slot, it waits for the slot and acts then — never earlier", async () => {
    const { approved, acts, press, platform, setNow } = setup();
    const [first, second] = approved("slideshows", slides(2)).tickets;
    press(first!.id); await acts.post(first!.id); await flush();
    press(second!.id);
    expect((await acts.post(second!.id))).toMatchObject({ state: "scheduled", slotAt: T0 + 2 * H });
    // THE MUTANT: no early-timer guard in `execute` — a timer that fires early posts early.
    await acts.execute(second!.id);
    expect(platform.calls).toHaveLength(1);
    expect(acts.ticket(second!.id).state).toBe("scheduled");
    setNow(T0 + 2 * H);
    await acts.execute(second!.id);
    expect(platform.calls).toHaveLength(2);
  });

  it("an act that went out a few seconds late moves the next slot by those seconds, not by a whole gap", async () => {
    const { approved, acts, press, setNow } = setup();
    const [a, b, c] = approved("slideshows", slides(3)).tickets;
    setNow(T0 + 5_000);
    press(a!.id); await acts.post(a!.id); await flush();
    // THE MUTANT: other waiting tickets' plans held against a refresh — 4 PM collides with the 6 PM
    // plan, and the second post is pushed to 8 PM.
    expect(acts.ticket(b!.id).slotAt).toBe(T0 + 2 * H + 5_000);
    expect(acts.ticket(c!.id).slotAt).toBe(T0 + 4 * H);
  });

  it("a slot that moved since the sheet showed it is said, and nothing goes out at a time the person did not see", async () => {
    const { approved, acts, press, platform } = setup();
    const t = approved("slideshows", slides(1)).tickets[0]!;
    press(t.id, { slotAt: t.slotAt + 3 * H });
    await expect(acts.post(t.id)).rejects.toMatchObject({ code: "TEAM_SLOT_MOVED" });
    expect(platform.calls).toEqual([]);
  });
});

describe("the guardrails", () => {
  it("refuses a post whose account has no consent on its record line", async () => {
    const { approved, acts, press, platform } = setup();
    const t = approved("slideshows", [{ files: ["deck/x.png"], body: "#ad", target: { channel: "Instagram", account: "@versed.nathan" } }]).tickets[0]!;
    press(t.id);
    // THE MUTANT: drop `consentProblem` from the press.
    await expect(acts.post(t.id)).rejects.toMatchObject({ code: "TEAM_NO_CONSENT" });
    expect(platform.calls).toEqual([]);
  });

  it("refuses at the slot when consent was taken off the record after the press", async () => {
    const { approved, acts, press, platform, setNow, setRecord } = setup();
    const [a, b] = approved("slideshows", slides(2)).tickets;
    press(a!.id); await acts.post(a!.id); await flush();
    press(b!.id); await acts.post(b!.id);
    setRecord(RECORD.replace(" · consent: contract §4", ""));
    setNow(T0 + 2 * H);
    await acts.execute(b!.id);
    expect(platform.calls).toHaveLength(1);
    expect(acts.ticket(b!.id)).toMatchObject({ state: "ready" });
  });

  it("refuses a file changed after the yes — at the press, and the ticket is cancelled", async () => {
    const { approved, acts, press, platform, folder } = setup();
    const t = approved("slideshows", slides(1)).tickets[0]!;
    writeFileSync(join(folder, "deck/1-a.png"), "a different picture");
    press(t.id);
    // THE MUTANT: compare the press's hash only, never the bytes on disk.
    await expect(acts.post(t.id)).rejects.toMatchObject({ code: "TEAM_TICKET_CHANGED" });
    expect(platform.calls).toEqual([]);
    expect(acts.ticket(t.id).state).toBe("cancelled");
  });

  it("refuses a file changed between the press and the slot: the staged copies are hashed before the platform sees them", async () => {
    const { approved, acts, press, platform, folder, setNow } = setup();
    const [a, b] = approved("slideshows", slides(2)).tickets;
    press(a!.id); await acts.post(a!.id); await flush();
    press(b!.id); await acts.post(b!.id);
    writeFileSync(join(folder, "deck/2-b.png"), "swapped after the press");
    setNow(T0 + 2 * H);
    await acts.execute(b!.id);
    expect(platform.calls).toHaveLength(1);
    expect(acts.ticket(b!.id).state).toBe("cancelled");
  });

  it("refuses a post that discloses nothing, and takes the platform's label as disclosure when ticked", async () => {
    const { approved, acts, press, platform } = setup();
    const t = approved("slideshows", [{ files: ["deck/q.png"], body: "no tag here", target: { channel: "TikTok", account: "@versed.nathan" } }]).tickets[0]!;
    expect(t.disclosure).toBeNull();
    press(t.id);
    await expect(acts.post(t.id)).rejects.toMatchObject({ code: "TEAM_NO_DISCLOSURE" });
    press(t.id, { label: true });
    await acts.post(t.id); await flush();
    expect(platform.calls[0]!.paidPartnershipLabel).toBe(true);
  });

  it("caps DMs at 15 a day per account: a 16th is planned for tomorrow", () => {
    const { approved } = setup();
    const { tickets } = approved("message", dms(16));
    const at = tickets.map((t) => t.slotAt).sort((a, b) => a - b);
    // THE MUTANT: the DM cap at 16, or unchecked.
    expect(at.filter((t) => day(t) === 9)).toHaveLength(ACT_PACING.dm.perDay);
    expect(day(at[15]!)).toBe(10);
    for (let i = 1; i < 15; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(3 * 60_000);
  });

  it("refuses a 16th DM the same day at the press, when fifteen went out since it was planned", async () => {
    const { approved, acts, press, platform, store } = setup();
    const t = approved("message", dms(1)).tickets[0]!;
    // Fifteen DMs from the account went out today, after this one was planned for 2 PM.
    approved("message", dms(15)).tickets.forEach((x, i) => store.update(x.id, { state: "done", actedAt: T0 - 5 * H + i * 10 * 60_000 }));
    press(t.id, { slotAt: T0 });
    await expect(acts.post(t.id)).rejects.toMatchObject({ code: "TEAM_SLOT_MOVED" });
    expect(platform.calls).toEqual([]);
    expect(day(acts.ticket(t.id).slotAt)).toBe(10);
  });

  it("caps a team's DMs at 15 a day across its accounts", () => {
    const { approved } = setup();
    const many = Array.from({ length: 16 }, (_, i) => ({ body: `hi ${i}`, target: { channel: "TikTok", account: `@acct${i % 4}`, to: `@r${i}` } }));
    const at = approved("message", many).tickets.map((t) => t.slotAt);
    // THE MUTANT: no team cap — four accounts, sixteen DMs, all on Friday.
    expect(at.filter((t) => day(t) === 9)).toHaveLength(ACT_PACING.dm.teamPerDay);
  });

  it("the kill switch: held, a pressed ticket goes back to waiting, no press is taken, and letting go acts on nothing by itself", async () => {
    const { approved, acts, press, platform, setNow } = setup();
    const [a, b] = approved("slideshows", slides(2)).tickets;
    press(a!.id); await acts.post(a!.id); await flush();
    press(b!.id); await acts.post(b!.id);
    // THE MUTANT: `hold` only writes its row, leaving the pressed ticket scheduled.
    acts.hold("S1", true);
    expect(acts.ticket(b!.id).state).toBe("ready");
    setNow(T0 + 2 * H);
    await acts.execute(b!.id);
    press(b!.id);
    await expect(acts.post(b!.id)).rejects.toMatchObject({ code: "TEAM_ACTS_HELD" });
    acts.hold("S1", false);
    await flush();
    expect(platform.calls).toHaveLength(1);
    press(b!.id);
    await acts.post(b!.id); await flush();
    expect(platform.calls).toHaveLength(2);
  });

  it("a held team's scheduled ticket does not act at its slot", async () => {
    const { approved, acts, press, platform, setNow, store } = setup();
    const [a, b] = approved("slideshows", slides(2)).tickets;
    press(a!.id); await acts.post(a!.id); await flush();
    press(b!.id); await acts.post(b!.id);
    store.hold("S1"); // the row alone, as a second window would see it
    setNow(T0 + 2 * H);
    // THE MUTANT: `execute` forgets to ask whether the team is held.
    await acts.execute(b!.id);
    expect(platform.calls).toHaveLength(1);
  });

  it("a platform that is not connected is said, and the press is not spent on it", async () => {
    const { approved, acts, press, platform } = setup();
    platform.connected = false;
    const t = approved("slideshows", slides(1)).tickets[0]!;
    press(t.id);
    await expect(acts.post(t.id)).rejects.toMatchObject({ code: "TEAM_ACT_NOT_CONNECTED" });
    expect(acts.ticket(t.id).adapter).toMatchObject({ connected: false });
  });

  it("a failure goes back to the person with its screenshot, and is never retried on its own", async () => {
    const { approved, acts, press, platform, verbs } = setup();
    platform.fail = true;
    const t = approved("slideshows", slides(1)).tickets[0]!;
    press(t.id); await acts.post(t.id); await flush(); await flush();
    expect(acts.ticket(t.id)).toMatchObject({ state: "ready", error: "the platform said no" });
    expect(acts.ticket(t.id).screenshot).toBeTruthy();
    expect(platform.calls).toHaveLength(1);
    expect(verbs()).toContain("act_failed");
  });

  it("asking for changes takes back every ticket not yet out", async () => {
    const { approved, acts } = setup();
    const { review, tickets } = approved("slideshows", slides(3));
    acts.cancelForReview(review.id, "you asked for changes");
    expect(acts.tickets(review.id)).toEqual([]);
    expect(tickets).toHaveLength(3);
  });
});

describe("kinds", () => {
  it.each<[ReviewKind, string, ActKind | null]>([["slideshows", "TikTok", "post"], ["message", "email", "email"], ["message", "Instagram", "dm"], ["report", "TikTok", null]])(
    "%s on %s is %s", (kind, channel, want) => {
      const { approved } = setup();
      const target = { channel, account: "@versed.nathan", ...(kind === "message" ? { to: "x@y.z" } : {}) };
      const t = approved(kind, [{ files: ["deck/k.png"], body: "#ad", target }]).tickets[0];
      expect(t?.kind ?? null).toBe(want);
    });
});
