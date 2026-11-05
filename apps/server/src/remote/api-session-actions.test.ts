import { describe, expect, it } from "vitest";
import type { Account, Checkpoint, MethodName, SavedTurn, Session } from "@realm/contracts";
import { MobileCalls } from "@realm/remote";
import { MobileApi, MobileError } from "./api";
import { channel, fakeRpc, item, session, space } from "./api.test-fakes";
import { RpcCallError, type RpcPort } from "./rpc-port";

/**
 * The session actions the desktop's menus carry — Delete, Fork, Move to space…, Switch agent…, Account…
 * and a saved turn — as mobile.v1 hands each to the desktop's own call, and the desktop's refusals as a
 * phone is told them.
 */

const api = () => new MobileApi({ macName: () => "Test Mac", reportsDir: "/nonexistent", realmHome: "/nonexistent", dev: false });

async function attempt(rpc: RpcPort, method: string, params: unknown): Promise<{ ok: true; result: unknown } | { ok: false; code: string; message: string }> {
  try { return { ok: true, result: await api().handle(channel(rpc), method, params) }; }
  catch (e) { if (e instanceof MobileError) return { ok: false, code: e.code, message: e.message }; throw e; }
}

/** A fake of the desktop's RPC over one session, recording what each extra method was asked. */
function rig(sessions: Session[], more: Partial<Record<MethodName, (p: never) => unknown>> = {}) {
  const asked: [string, unknown][] = [];
  const wrapped = Object.fromEntries(Object.entries(more).map(([m, fn]) => [m, (p: never) => { asked.push([m, p]); return fn(p); }]));
  const rpc = fakeRpc({ spaces: [space("s1"), space("s2")], sessions, items: sessions.map((s) => item(s.id, s.spaceId, `${s.id} title`)) }, wrapped);
  return { rpc, asked };
}

const refusing = (code: string, message: string) => () => { throw new RpcCallError(code, message); };

describe("session.delete", () => {
  it("deletes the session by the desktop's own call, not archiving it", async () => {
    const { rpc, asked } = rig([session("a", "s1")], { "sessions.delete": (() => ({ ok: true })) as never });
    expect(await attempt(rpc, "session.delete", { id: "a" })).toEqual({ ok: true, result: { ok: true } });
    // THE MUTANT: `items.update` with `archived: true`, which keeps the transcript the person meant to lose.
    expect(asked).toEqual([["sessions.delete", { id: "a" }]]);
  });
});

describe("session.fork", () => {
  const checkpoint = { id: "cp1", environmentId: "env", sessionId: "a", kind: "manual" } as Checkpoint;

  it("forks the session as it is now: a checkpoint for it this moment, then Fork… from that one", async () => {
    const sessions = [session("a", "s1", { environmentId: "env", agentKind: "claude" })];
    const { rpc, asked } = rig(sessions, {
      "checkpoints.capture": (() => checkpoint) as never,
      "sessions.fork": (() => { sessions.push(session("f", "s1", { title: "Fork: a title", agentKind: "claude" })); return { session: sessions.at(-1), itemId: "i-f", environment: {} }; }) as never,
    });
    const got = await attempt(rpc, "session.fork", { id: "a" });
    expect(asked).toEqual([
      ["checkpoints.capture", { environmentId: "env", sessionId: "a", label: "Fork" }],
      // Same agent: nothing names it, so the desktop's own default (the ancestor's) holds.
      ["sessions.fork", { checkpointId: "cp1" }],
    ]);
    expect(got.ok && MobileCalls["session.fork"].result.parse(got.result).session).toMatchObject({ id: "f", agent: "claude" });
  });

  it("forks onto another agent where one is named, and the same one as no agent at all", async () => {
    const sessions = [session("a", "s1", { environmentId: "env", agentKind: "claude" }), session("f", "s1")];
    const { rpc, asked } = rig(sessions, {
      "checkpoints.capture": (() => checkpoint) as never,
      "sessions.fork": (() => ({ session: sessions[1], itemId: "i-f", environment: {} })) as never,
    });
    await attempt(rpc, "session.fork", { id: "a", agent: "codex" });
    await attempt(rpc, "session.fork", { id: "a", agent: "claude" });
    expect(asked.filter(([m]) => m === "sessions.fork").map(([, p]) => p)).toEqual([{ checkpointId: "cp1", agentKind: "codex" }, { checkpointId: "cp1" }]);
    expect(await attempt(rpc, "session.fork", { id: "a", agent: "nobody" })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("refuses in the Mac's words where there is nothing to fork", async () => {
    const words = "/tmp/plain is not a git repository any more; the checkpoint cannot be forked";
    const { rpc } = rig([session("a", "s1")], { "checkpoints.capture": refusing("NOT_A_REPOSITORY", words) as never });
    expect(await attempt(rpc, "session.fork", { id: "a" })).toEqual({ ok: false, code: "FORBIDDEN", message: words });
  });
});

describe("session.moveToSpace", () => {
  it("moves it by the sidebar's own call and answers its row in the space it is in now", async () => {
    const sessions = [session("a", "s1")];
    const { rpc, asked } = rig(sessions, {
      "sessions.moveToSpace": ((p: { id: string; spaceId: string }) => { sessions[0] = { ...sessions[0]!, spaceId: p.spaceId }; return sessions[0]; }) as never,
    });
    const got = await attempt(rpc, "session.moveToSpace", { id: "a", spaceId: "s2" });
    expect(asked).toEqual([["sessions.moveToSpace", { id: "a", spaceId: "s2" }]]);
    expect(got.ok && MobileCalls["session.moveToSpace"].result.parse(got.result).session).toMatchObject({ id: "a", spaceId: "s2", spaceName: "Space s2" });
  });
});

describe("session.switchAgent", () => {
  it("hands the switch to the desktop's own call, a model left out as the agent's default", async () => {
    const sessions = [session("a", "s1", { agentKind: "claude" })];
    const { rpc, asked } = rig(sessions, {
      "sessions.switchAgent": ((p: { agentKind: Session["agentKind"] }) => { sessions[0] = { ...sessions[0]!, agentKind: p.agentKind }; return sessions[0]; }) as never,
    });
    const got = await attempt(rpc, "session.switchAgent", { id: "a", agent: "codex" });
    await attempt(rpc, "session.switchAgent", { id: "a", agent: "claude", model: "claude-opus-5-5" });
    expect(asked).toEqual([
      ["sessions.switchAgent", { sessionId: "a", agentKind: "codex", model: null }],
      ["sessions.switchAgent", { sessionId: "a", agentKind: "claude", model: "claude-opus-5-5" }],
    ]);
    expect(got.ok && MobileCalls["session.switchAgent"].result.parse(got.result).session.agent).toBe("codex");
  });

  it("refuses mid-turn in the Mac's words, and an agent the Mac has no name for", async () => {
    const busy = "Claude is still working on this turn. Stop it or let it finish, then switch.";
    const { rpc, asked } = rig([session("a", "s1", { agentKind: "claude" })], { "sessions.switchAgent": refusing("SESSION_BUSY", busy) as never });
    expect(await attempt(rpc, "session.switchAgent", { id: "a", agent: "codex" })).toEqual({ ok: false, code: "FORBIDDEN", message: busy });
    expect(await attempt(rpc, "session.switchAgent", { id: "a", agent: "nobody" })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
    expect(asked).toHaveLength(1);
  });
});

describe("session.accounts and session.setAccount", () => {
  const account = (id: string, kind: Account["kind"], extra: Partial<Account> = {}): Account =>
    ({ id, kind, label: id, configDir: `/tmp/${id}`, signedIn: true, email: `${id}@example.com`, plan: null, createdAt: 0, ...extra });
  const accounts = [
    account("default-claude", "claude", { label: "Default", configDir: null, email: null, signedIn: null }),
    account("work", "claude"), account("default-codex", "codex", { configDir: null }),
  ];

  it("lists the session's agent's accounts, the one in force being its CLI's own where it names none", async () => {
    const { rpc } = rig([session("a", "s1", { agentKind: "claude" }), session("b", "s1", { agentKind: "claude", accountId: "work" }), session("c", "s1")],
      { "accounts.list": (() => ({ accounts })) as never });
    expect(await attempt(rpc, "session.accounts", { id: "a" })).toEqual({ ok: true, result: {
      accounts: [
        { id: "default-claude", label: "Default", email: null, cliDefault: true, signedIn: null },
        { id: "work", label: "work", email: "work@example.com", cliDefault: false, signedIn: true },
      ],
      current: "default-claude",
    } });
    expect(await attempt(rpc, "session.accounts", { id: "b" })).toMatchObject({ ok: true, result: { current: "work" } });
    // An agent with no accounts has none to offer, and the phone offers no Account… for it.
    expect(await attempt(rpc, "session.accounts", { id: "c" })).toEqual({ ok: true, result: { accounts: [], current: null } });
  });

  it("sends the CLI's own account as null, as the desktop's picker does, and refuses mid-turn in its words", async () => {
    const { rpc, asked } = rig([session("a", "s1", { agentKind: "claude" })], { "sessions.setAccount": ((p: unknown) => p) as never });
    await attempt(rpc, "session.setAccount", { id: "a", accountId: "work" });
    await attempt(rpc, "session.setAccount", { id: "a", accountId: "default-claude" });
    expect(asked).toEqual([["sessions.setAccount", { id: "a", accountId: "work" }], ["sessions.setAccount", { id: "a", accountId: null }]]);
    const busy = "Claude is still working on this turn. Stop it or let it finish, then switch accounts.";
    const { rpc: running } = rig([session("a", "s1", { agentKind: "claude" })], { "sessions.setAccount": refusing("SESSION_BUSY", busy) as never });
    expect(await attempt(running, "session.setAccount", { id: "a", accountId: "work" })).toEqual({ ok: false, code: "FORBIDDEN", message: busy });
  });
});

describe("saved turns", () => {
  it("reads and sets a session's saved turns by the desktop's own calls", async () => {
    const { rpc, asked } = rig([session("a", "s1")], {
      "sessions.saved": (() => ({ seqs: [3] })) as never,
      "sessions.setSaved": ((p: { seq: number; saved: boolean }) => ({ seqs: p.saved ? [3, p.seq] : [] })) as never,
    });
    expect(await attempt(rpc, "session.saved", { id: "a" })).toEqual({ ok: true, result: { seqs: [3] } });
    expect(await attempt(rpc, "session.setSaved", { id: "a", seq: 9, saved: true })).toEqual({ ok: true, result: { seqs: [3, 9] } });
    expect(asked).toEqual([["sessions.saved", { id: "a" }], ["sessions.setSaved", { id: "a", seq: 9, saved: true }]]);
    expect(await attempt(rpc, "session.setSaved", { id: "a", seq: 0, saved: true })).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  });

  it("lists a profile's saved turns as Library ▸ Saved does, each with its space's name", async () => {
    const saved: SavedTurn = {
      sessionId: "a", seq: 4, savedAt: 20, ts: 10, text: "Rename the column", attachments: [], goal: null, reply: "Renamed it.", sessionTitle: "Theme", spaceId: "s2",
    };
    const { rpc, asked } = rig([session("a", "s2")], { "library.saved": (() => ({ entries: [saved], total: 1 })) as never });
    const got = await attempt(rpc, "saved.list", { profileId: "p1" });
    expect(asked).toEqual([["library.saved", { profileId: "p1" }]]);
    expect(got).toEqual({ ok: true, result: { total: 1, entries: [{
      sessionId: "a", seq: 4, savedAt: 20, at: 10, text: "Rename the column", attachments: [], reply: "Renamed it.", sessionTitle: "Theme", spaceId: "s2", spaceName: "Space s2",
    }] } });
    expect(MobileCalls["saved.list"].result.parse((got as { result: unknown }).result).entries).toHaveLength(1);
  });
});
