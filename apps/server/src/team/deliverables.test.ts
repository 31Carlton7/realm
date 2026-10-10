import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { ACT_PACING, type ActKind } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { TeamStore } from "./store";
import { TeamService } from "./service";
import { createTeamAgentProvider } from "./agent-tools";
import { ActStore } from "./acts/store";
import { ActService } from "./acts/service";

/**
 * Generic deliverables in Review: a submission is files, text, meta and an optional proposed action,
 * drawn by format; submit refuses only what could never be fixed later; and the person may edit an
 * item's text before the yes, which becomes the batch's next version. Each test names its mutant.
 */

function setup() {
  const home = tempDir("realm-deliverables-");
  const db = openDatabase(join(home, "realm.db"));
  db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES ('p', 'P', 'x', '#000', 0, 1, 1)").run();
  const folder = join(home, "space");
  mkdirSync(join(folder, "out"), { recursive: true });
  db.prepare("INSERT INTO spaces (id, profile_id, name, icon, sort_order, folder_path, created_at, updated_at) VALUES ('S1', 'p', 'Desk', 'f', 0, ?, 1, 1)").run(folder);
  db.prepare(`INSERT INTO team_roles (id, space_id, name, brief, realmite_json, agent_kind, created_at, updated_at) VALUES ('R1', 'S1', 'Writer', 'Write.', '{}', 'fake', 1, 1)`).run();
  let now = 1_000;
  const store = new TeamStore(db, () => now);
  const team = new TeamService({
    store,
    acts: { issue: () => [], cancelForReview: () => {}, tickets: () => [], counts: () => ({ total: 0, done: 0 }), held: () => false,
      today: (k: ActKind) => ({ count: 0, cap: ACT_PACING[k].perDay }) },
    runs: { get: () => null, listLive: () => [], spentSince: () => 0 } as never,
    schedules: {} as never, sessions: { publishServerEvent: () => {} } as never,
    repos: { config: () => null } as never,
    rootForSpace: () => folder, spaceExists: () => true,
    settings: { get: () => undefined, set: () => {} }, rpc: { broadcast: () => {} }, clock: () => now,
  });
  const ctx = { sessionId: "SESS", spaceId: "S1" };
  const verbs = () => store.activity("S1", 100).map((a) => a.verb).reverse();
  return { db, team, store, folder, ctx, verbs, tick: () => { now += 1_000; } };
}

describe("review_submit, generic", () => {
  it("keeps an item's files, text, meta, format and action, under the label as written", () => {
    const { team, ctx, folder } = setup();
    writeFileSync(join(folder, "out/brief.pdf"), "%PDF-1.4");
    const r = team.submit(ctx, { kind: "Replies for Tuesday", title: "Replies", items: [
      { files: [], body: "Hi Dana — thanks for Monday.", meta: { Subject: "Following up" }, action: { connector: "mcp:gmail", tool: "send_message", verb: "send", account: "me@versed.app", to: "dana@acme.com" } },
      { files: ["out/brief.pdf"], format: "pdf" },
    ] });
    const d = team.review(r.id);
    expect(d.kind).toBe("Replies for Tuesday");
    expect(d.items[0]).toMatchObject({ meta: { Subject: "Following up" }, format: null, action: { connector: "mcp:gmail", verb: "send", to: "dana@acme.com" }, editedBy: null });
    expect(d.items[1]).toMatchObject({ files: ["out/brief.pdf"], format: "pdf", action: null });
    // THE MUTANT: the summary reading only `target` — a new action's account vanishes from the card.
    expect(d).toMatchObject({ format: "email", account: "me@versed.app", channels: [] });
    // A connector's tool is not a channel act: Realm says it will not do it, rather than claiming a slot,
    // and asks no creator's consent for a mailbox that sends as itself.
    // THE MUTANT: the consent check on every account — "me@versed.app has no consent on record".
    expect(d.checks).toEqual([{ ok: null, title: "Realm does not send this yet", detail: "It proposes send send_message through mcp:gmail. Approving marks it ready; do it yourself for now." }]);
  });

  it("with no label, stands the first item's format in, so the card says what it holds", () => {
    const { team, ctx } = setup();
    const r = team.submit(ctx, { title: "Reading list", items: [{ files: [], body: "- https://arxiv.org/abs/1\n- https://example.com/x" }] });
    expect(r).toMatchObject({ kind: "links", format: "links" });
  });

  it("issues a ticket for a new channel action under any label, by its verb", () => {
    const { team, ctx, db, store, folder } = setup();
    writeFileSync(join(folder, "out/01.png"), "png");
    const r = team.submit(ctx, { kind: "posts for Nathan", title: "Posts", items: [
      { files: ["out/01.png"], body: "#ad", action: { connector: "channel:tiktok", verb: "post", account: "@versed.nathan" } },
      { files: [], body: "a reply", action: { connector: "mcp:gmail", verb: "send", account: "me@x.co", to: "d@y.co" } },
    ] });
    team.approve(r.id);
    const at = new Date(2026, 9, 9, 14).getTime();
    const acts = new ActService({
      store: new ActStore(db, () => at), team: store, rootForSpace: () => folder, record: () => null,
      presses: { consume: async () => ({ pressed: false, label: false, slotAt: null }) },
      adapter: () => ({ status: () => ({ connected: false, label: "x", why: "x" }), act: async () => ({ ok: false, error: "x", screenshot: null }) }),
      proofDir: join(folder, "..", "proof"), rpc: { broadcast: () => {} } as never, clock: () => at,
    });
    // THE MUTANT: issue reading the legacy label only — "posts for Nathan" is no slideshow, and nothing is issued.
    expect(acts.issue(r.id).map((t) => ({ kind: t.kind, channel: t.channel, account: t.account }))).toEqual([{ kind: "post", channel: "tiktok", account: "@versed.nathan" }]);
  });

  it("reads a `target` as the action the legacy label always made of it", () => {
    const { team, ctx } = setup();
    const r = team.submit(ctx, { kind: "message", title: "DM", items: [{ files: [], body: "hi", target: { channel: "Instagram", account: "@a", to: "@b" } }] });
    expect(team.review(r.id).items[0]!.action).toEqual({ verb: "dm", connector: "channel:instagram", account: "@a", to: "@b", legacy: 1 });
  });

  it("refuses a secret's shape in the text, the meta or the action — and nothing else that could be fixed later", () => {
    const { team, ctx, store } = setup();
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    // THE MUTANT: the meta or the action left out of the secret check.
    expect(() => team.submit(ctx, { kind: "x", title: "t", items: [{ files: [], body: `use ${key}` }] })).toThrow(/looks like an API key/);
    expect(() => team.submit(ctx, { kind: "x", title: "t", items: [{ files: [], body: "ok", meta: { Token: key } }] })).toThrow(/looks like an API key/);
    expect(() => team.submit(ctx, { kind: "x", title: "t", items: [{ files: [], body: "ok", action: { connector: "mcp:x", args: { auth: key } } }] })).toThrow(/looks like an API key/);
    expect(() => team.submit(ctx, { kind: "x", title: "t", items: [{ files: ["/etc/hosts"] }] })).toThrow(/outside this space's folder/);
    expect(store.reviews("S1")).toEqual([]);
  });
});

describe("edit, then approve", () => {
  const email = { kind: "replies", title: "Reply to Dana", items: [
    { files: [], body: "Hi Dana,\nthanks for Monday.\nCarlton", meta: { Subject: "Pilot" }, action: { connector: "mcp:gmail", verb: "send", account: "me@x.co", to: "dana@acme.com" } },
    { files: [], body: "Second reply" },
  ] };

  it("makes the batch's next version: the edited item marked the person's and hashed again, the rest carried over", () => {
    const { team, ctx, store } = setup();
    const r = team.submit(ctx, email);
    const [first, second] = team.review(r.id).items;
    const next = team.editItem(r.id, first!.id, "Hi Dana,\nthanks for the call on Monday.\nCarlton");
    expect(next).toMatchObject({ version: 2, state: "waiting", editedItems: [1] });
    // THE MUTANT: the old hash kept — read straight from the row, before any read re-hashes it.
    expect(store.items(r.id, 2)[0]!.contentHash).toBe(team.hashItem(team.review(r.id).root!, [], "Hi Dana,\nthanks for the call on Monday.\nCarlton"));
    const d = team.review(r.id);
    expect(d.items[0]).toMatchObject({ body: "Hi Dana,\nthanks for the call on Monday.\nCarlton", editedBy: "user", meta: { Subject: "Pilot" }, format: "email", action: { verb: "send" } });
    expect(d.items[0]!.contentHash).not.toBe(first!.contentHash);
    expect(d.items[1]).toMatchObject({ body: "Second reply", editedBy: null, contentHash: second!.contentHash });
    expect(d.previous.map((i) => i.body)).toEqual(["Hi Dana,\nthanks for Monday.\nCarlton", "Second reply"]);
    const line = store.activity("S1", 10).find((a) => a.verb === "edited_item")!;
    expect(line).toMatchObject({ actor: "user", detail: { item: 1, version: 2, diff: "-thanks for Monday.\n+thanks for the call on Monday." } });
  });

  it("Approve covers the edited bytes, and the role is told the person edited it", async () => {
    const { team, ctx, db } = setup();
    const r = team.submit(ctx, email);
    team.editItem(r.id, team.review(r.id).items[1]!.id, "Second reply, warmer");
    team.approve(r.id);
    const d = team.review(r.id);
    expect(d.items.every((i) => i.approvedHash === i.contentHash)).toBe(true);
    expect(d.items[1]!.approvedHash).toBe(team.hashItem(d.root!, [], "Second reply, warmer"));
    const tools = createTeamAgentProvider({ team, mcp: { providerEnabled: () => true } });
    const out = await tools.call({ sessionId: "SESS", spaceId: "S1" } as never, "review_status", { id: r.id });
    // THE MUTANT: review_status without the person's edits — the role rewrites what the person fixed.
    expect(JSON.stringify(out)).toContain("the person edited item 2 before approving");
    void db;
  });

  it("is only for text that IS the deliverable, only while it waits, and never empty", () => {
    const { team, ctx, folder } = setup();
    writeFileSync(join(folder, "out/01.png"), "png");
    const pics = team.submit(ctx, { kind: "slideshows", title: "Slides", items: [{ files: ["out/01.png"], body: "caption #ad" }] });
    // THE MUTANT: any format editable here — a picture's caption edited as if it were the picture.
    expect(() => team.editItem(pics.id, team.review(pics.id).items[0]!.id, "new caption")).toThrow(/edited in Documents/);
    const r = team.submit(ctx, email);
    const id = team.review(r.id).items[0]!.id;
    expect(() => team.editItem(r.id, id, "   ")).toThrow(/empty/);
    team.approve(r.id);
    expect(() => team.editItem(r.id, id, "after the yes")).toThrow(/only work waiting for you/);
  });

  it("an unchanged text makes no version", () => {
    const { team, ctx } = setup();
    const r = team.submit(ctx, email);
    const it0 = team.review(r.id).items[0]!;
    expect(team.editItem(r.id, it0.id, it0.body!)).toMatchObject({ version: 1 });
  });
});
