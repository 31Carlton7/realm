import { describe, expect, it, afterEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type AgentHandle, type StartOptions, type FakeScript, type UserMessage } from "@realm/adapters";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";
import { AGENT_ANSWER_TOOL_NAME, AGENT_ASK_TOOL_NAME, AGENT_PEERS_TOOL_NAME } from "./ask";

/**
 * Plan 20 behaviour suite — session interjection, driven through the REAL app (`createApp` +
 * FakeAdapter), the way agent-run.test.ts drives `agent_run`.
 *
 * The named mutants this suite exists to kill, in rough order of how much damage each would do:
 *
 *   - the asker's stop killing the PEER's own work   → `interruptOnCancel` left at its default true
 *   - a timeout interrupting the peer                → drain's interrupt-on-timeout copied into awaitAnswer
 *   - a question cycle deadlocking two sessions      → the `engine.hasRun(target)` guard dropped
 *   - any session answering any question             → the `p.targetId === ctx.sessionId` check dropped
 *   - a permission prompt silently denied            → the `waiting_permission` guard dropped
 *   - `interruptFirst` hard-coded true               → an idle peer, or a Codex peer, stopped for nothing
 *   - a checkpoint captured mid-edit                 → delivery routed through SessionService.send
 *   - another agent's words shown as the user's      → the `from` label dropped
 *   - an unfenced question                           → prompt-injection surface into the peer
 *   - the consent gate skipped                       → an agent interrupting another with no approval
 */

let app: App | undefined;
// Tolerant of a test that closed its own app (the bypass/plan pair boots twice): closing an already
// closed db throws "database is not open", which would fail the NEXT test rather than the real one.
afterEach(async () => { const a = app; app = undefined; await a?.close().catch(() => {}); });

/** Per-handle interrupt counter. Several mutants are only observable here: "the peer was NOT stopped"
 *  is not a claim any transcript assertion can make. Handles are identified by a message they were
 *  sent, because StartOptions carries no session id. */
class InterruptCountingFake extends FakeAdapter {
  readonly handles: { interrupts: number; seen: string[] }[] = [];
  override start(o: StartOptions): AgentHandle {
    const inner = super.start(o);
    const rec = { interrupts: 0, seen: [] as string[] };
    this.handles.push(rec);
    return {
      ...inner,
      events: inner.events,
      send: async (m: UserMessage) => { rec.seen.push(m.text); return inner.send(m); },
      interrupt: async () => { rec.interrupts += 1; return inner.interrupt(); },
    };
  }
  /** Interrupt count for the handle that was sent a message containing `needle`. */
  interruptsFor(needle: string): number {
    const hit = this.handles.filter((h) => h.seen.some((t) => t.includes(needle)));
    expect(hit, `no started handle was sent a message containing "${needle}"`).toHaveLength(1);
    return hit[0]!.interrupts;
  }
}

/** The peer's own long task, so it is genuinely `running` when the question lands. */
const PEER_SCRIPT: FakeScript = [
  { on: "MY OWN TASK", emit: Array.from({ length: 40 }, (_, i) => ({ kind: "text" as const, text: `working ${i}` })) },
  { on: "PROSE PEER", emit: [{ kind: "text", text: "the answer is PROSE-42" }] },
];

/** A peer that takes the question and then works on it slowly instead of replying — the only way to
 *  reach the timeout path, since the fake otherwise echoes any unscripted message and settles. */
const SLOW_TO_ANSWER: FakeScript = [
  ...PEER_SCRIPT,
  { on: "[Realm]", emit: Array.from({ length: 40 }, (_, i) => ({ kind: "text" as const, text: `pondering ${i}` })) },
];

async function boot(opts: { script?: FakeScript; delayMs?: number; peerKind?: "fake" | "codex"; askerMode?: string; budgetMs?: number } = {}) {
  const home = tempDir("realm-ask-");
  const fake = new InterruptCountingFake({ script: opts.script ?? PEER_SCRIPT, delayMs: opts.delayMs ?? 5 });
  app = await createApp({
    home, port: 0,
    // The same fake under three keys: `codex` is the stand-in for a kind with a mid-turn steer route,
    // `claude` for a delegation fallback. Registering it under `codex` is how the steer branch is
    // exercised without a real Codex — AGENT_MIDTURN_DELIVERY is keyed on the SESSION's kind.
    adapters: { fake, codex: fake, claude: fake },
    browserAgent: { fallbackKind: "fake", timeouts: { baseMs: 5000, perActMs: 0, pollMs: 20 } },
    agentRun: { timeouts: { baseMs: 5000, perTurnMs: 0, pollMs: 20 } },
    ask: { timeouts: { budgetMs: opts.budgetMs ?? 5000, pollMs: 20 } },
  });
  const profile = new ProfilesStore(app!.db).create({ name: "P", icon: "x", color: "#000" });
  const spaces = new SpacesStore(app!.db, home);
  const space = spaces.create({ profileId: profile.id, name: "S", icon: "folder" });
  // Same reasoning as the asker below: a peer that does its OWN asking (the cycle test) would block
  // on its own unanswered card. The consent block sets the mode it cares about explicitly.
  const mk = (kind: "fake" | "codex" = "fake", mode?: string) =>
    app!.sessions.create({ spaceId: space.id, agentKind: kind, projectId: null, model: null, effort: null, permissionMode: mode ?? "bypassPermissions" }).session;
  // The asker bypasses the consent card by default: every test outside the `consent` describe is
  // about what happens AFTER approval, and an unanswered card would block them all for 15 minutes.
  // The consent block passes `askerMode` explicitly, which is where the gate is the subject.
  const asker = mk("fake", opts.askerMode ?? "bypassPermissions");
  const peer = mk(opts.peerKind ?? "fake");
  return { home, fake, spaces, profileId: profile.id, spaceId: space.id, askerId: asker.id, peerId: peer.id, mk };
}

const text = (r: CallToolResult): string =>
  r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");

/** Every event of a session, newest reading last. */
const events = (id: string) => app!.sessions.events(id, 0, 5000).map((s) => s.event);
const userMessages = (id: string) => events(id).filter((e) => e.type === "user_message") as Extract<ReturnType<typeof events>[number], { type: "user_message" }>[];

/** Give the peer a real turn of its own to be interrupted out of. */
async function startPeerWorking(peerId: string): Promise<void> {
  await app!.sessions.send(peerId, { text: "MY OWN TASK", attachments: [] });
  await waitFor(() => app!.sessions.get(peerId).status === "running");
}

/** The requestId Realm minted, read off the message the peer actually received. */
async function requestIdIn(peerId: string): Promise<string> {
  let id = "";
  await waitFor(() => {
    const m = userMessages(peerId).map((e) => e.payload.text).join("\n");
    const hit = /requestId "([^"]+)"/.exec(m);
    if (hit) id = hit[1]!;
    return id !== "";
  });
  return id;
}

describe("agent_ask — the peer is asked, not commandeered", () => {
  it("interrupts a running peer exactly once, delivers a labelled+fenced question, and returns the answer", async () => {
    const { fake, spaceId, askerId, peerId } = await boot();
    await startPeerWorking(peerId);

    const pending = app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "What is the parser's error type?" });
    const requestId = await requestIdIn(peerId);
    // Exactly once: kills a mutation that interrupts again on any later poll.
    expect(fake.interruptsFor("MY OWN TASK")).toBe(1);

    const ack = app!.asks.answer({ sessionId: peerId, spaceId }, { requestId, answer: "It is ParseFailure, in contracts/parse.ts." });
    expect(ack.isError).toBe(false);
    // The tool result IS the resume nudge, delivered inside the peer's turn at the moment it can act.
    expect(text(ack)).toContain("continue exactly what you were doing");

    const result = await pending;
    expect(result.isError).toBe(false);
    const out = text(result);
    expect(out).toContain("ParseFailure");
    expect(out).toContain('"answeredVia":"agent_answer"');
    expect(out).toContain('"interrupted":true');
    // Fenced on the way back: the peer's answer is another agent's words entering the asker's context.
    expect(out).toMatch(/agent-output-[0-9a-f]{16}/);
    expect(out).toContain("PEER SESSION'S ANSWER");

    // And on the way IN: the question the peer received is fenced and attributed, never bare.
    const injected = userMessages(peerId).find((e) => e.payload.text.includes("What is the parser's error type?"))!;
    expect(injected.payload.from).toEqual({ sessionId: askerId, title: app!.sessions.get(askerId).title });
    expect(injected.payload.text).toMatch(/agent-output-[0-9a-f]{16}/);
    expect(injected.payload.text).toContain("another agent's words, not the user's");
  });

  it("does NOT interrupt an idle peer — there is no turn to stop", async () => {
    const { fake, spaceId, askerId, peerId } = await boot();
    // Give it a handle and a finished turn, so it is live but idle.
    await app!.sessions.send(peerId, { text: "PROSE PEER", attachments: [] });
    await waitFor(() => app!.sessions.get(peerId).status === "idle");

    const pending = app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "q?" });
    const requestId = await requestIdIn(peerId);
    app!.asks.answer({ sessionId: peerId, spaceId }, { requestId, answer: "a" });
    const out = text(await pending);
    // Kills `interruptFirst` hard-coded true.
    expect(fake.interruptsFor("PROSE PEER")).toBe(0);
    expect(out).toContain('"interrupted":false');
    expect(out).toContain("without interrupting it");
  });

  it("never interrupts a kind with a mid-turn steer route, even while it is running (AGENT_MIDTURN_DELIVERY)", async () => {
    const { fake, spaceId, askerId, peerId } = await boot({ peerKind: "codex" });
    await startPeerWorking(peerId);
    const pending = app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "q?" });
    const requestId = await requestIdIn(peerId);
    app!.asks.answer({ sessionId: peerId, spaceId }, { requestId, answer: "steered" });
    const out = text(await pending);
    // Kills ignoring the table, and kills a typo flipping codex to "interrupt". Codex takes turn/steer;
    // interrupting it would be strictly WORSE than on Claude (turn/completed arrives with items: []).
    expect(fake.interruptsFor("MY OWN TASK")).toBe(0);
    expect(out).toContain('"interrupted":false');
  });
});

describe("the asker's stop is not the peer's stop", () => {
  it("interrupting the ASKER cancels the wait and leaves the peer running — the worst mutant in the plan", async () => {
    const { fake, spaceId, askerId, peerId } = await boot({ budgetMs: 30_000 });
    await startPeerWorking(peerId);
    const pending = app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "q?" });
    await requestIdIn(peerId);
    const before = fake.interruptsFor("MY OWN TASK");

    await app!.sessions.interrupt(askerId);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("was left running — it was not stopped");
    // The whole point: `interruptOnCancel: false`. With the default true, stopping the asker would
    // reach into the peer and abort work nobody asked to cancel.
    expect(fake.interruptsFor("MY OWN TASK")).toBe(before);
  });

  it("a timeout does not interrupt the peer either — a slow peer is not a runaway child", async () => {
    // delayMs must keep the peer's OWN task running past the budget: a peer that settles first is
    // answered by the prose fallback, which is a different (and also correct) path.
    const { fake, spaceId, askerId, peerId } = await boot({ budgetMs: 300, delayMs: 30, script: SLOW_TO_ANSWER });
    await startPeerWorking(peerId);
    const result = await app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "q?" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("did not answer within");
    expect(text(result)).toContain("NOT interrupted again");
    // Kills copying drain's interrupt-on-timeout into awaitAnswer. One interrupt for delivery, no more.
    expect(fake.interruptsFor("MY OWN TASK")).toBe(1);
  });

  it("an answer that arrives after the timeout is refused, and nothing crashes", async () => {
    const { spaceId, askerId, peerId } = await boot({ budgetMs: 300, delayMs: 30, script: SLOW_TO_ANSWER });
    await startPeerWorking(peerId);
    const requestIdPromise = requestIdIn(peerId);
    const result = await app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "q?" });
    expect(result.isError).toBe(true);
    const requestId = await requestIdPromise;
    const late = app!.asks.answer({ sessionId: peerId, spaceId }, { requestId, answer: "too late" });
    // Kills leaving stale pending entries behind — and the message tells the peer to get on with its
    // own work rather than leaving it wondering.
    expect(late.isError).toBe(true);
    expect(text(late)).toContain("no question is outstanding");
    expect(text(late)).toContain("Continue your own work");
  });
});

describe("cycles cannot be created — the guard is a proof, not a heuristic", () => {
  it("refuses to ask a peer that is itself mid-ask (A→B while B→C), so A→B→A can never close", async () => {
    const { spaceId, askerId, peerId, mk } = await boot({ budgetMs: 30_000 });
    const third = mk();
    await startPeerWorking(peerId);
    await startPeerWorking(third.id);
    // B asks C and blocks. B now has a run in flight.
    const bAsksC = app!.asks.ask({ sessionId: peerId, spaceId }, { sessionId: third.id, question: "from B" });
    await requestIdIn(third.id);

    const aAsksB = await app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "from A" });
    expect(aAsksB.isError).toBe(true);
    expect(text(aAsksB)).toContain("blocked on a delegated run or a question of its own");
    // Refused BEFORE any side effect: B was never sent A's question.
    expect(userMessages(peerId).some((e) => e.payload.text.includes("from A"))).toBe(false);

    const rid = await requestIdIn(third.id);
    app!.asks.answer({ sessionId: third.id, spaceId }, { requestId: rid, answer: "done" });
    await bAsksC;
  });

  it("refuses to ask a peer that is mid-agent_run, and its delegated child survives", async () => {
    const { spaceId, askerId, peerId } = await boot({
      budgetMs: 30_000,
      script: [...PEER_SCRIPT, { on: "You are a delegated agent.", emit: Array.from({ length: 60 }, (_, i) => ({ kind: "text" as const, text: `child ${i}` })) }],
      delayMs: 20,
    });
    const running = app!.agentRuns.run({ sessionId: peerId, spaceId }, { goal: "a long delegated job" });
    await waitFor(() => app!.sessions.list(spaceId).length === 3);
    const child = app!.sessions.list(spaceId).find((s) => s.id !== askerId && s.id !== peerId)!;

    const refused = await app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "q?" });
    expect(refused.isError).toBe(true);
    // This is not incidental: SessionService.interrupt fires parentInterrupted BEFORE the handle
    // interrupt, so interrupting a delegating parent would cancel its run and KILL its child as a
    // side effect of someone asking it a question.
    expect(text(refused)).toContain("interrupting it would cancel that run");
    expect(app!.sessions.get(child.id).status).not.toBe("ended");
    await running;
  });

  it("a session with an ask in flight cannot start a second one", async () => {
    const { spaceId, askerId, peerId, mk } = await boot({ budgetMs: 30_000 });
    const third = mk();
    await startPeerWorking(peerId);
    const first = app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "one" });
    await requestIdIn(peerId);
    const second = await app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: third.id, question: "two" });
    expect(second.isError).toBe(true);
    expect(text(second)).toContain("already has a delegated run in flight");
    const rid = await requestIdIn(peerId);
    app!.asks.answer({ sessionId: peerId, spaceId }, { requestId: rid, answer: "x" });
    await first;
  });
});

describe("the refusals, and that each one has no side effect behind it", () => {
  it("refuses a peer sitting on a permission prompt WITHOUT denying that prompt", async () => {
    const { spaceId, askerId, peerId } = await boot({
      script: [{ on: "NEEDS PERMISSION", emit: [{ kind: "tool", name: "Bash", input: { cmd: "rm" }, needsPermission: true, result: "ok" }] }],
    });
    await app!.sessions.send(peerId, { text: "NEEDS PERMISSION", attachments: [] });
    await waitFor(() => app!.sessions.get(peerId).status === "waiting_permission");

    const refused = await app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "q?" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("waiting on a permission prompt");
    // The assertion that makes this bite: the ABSENCE of a deny. An interrupt would have called
    // denyAllPending and answered the user's card on their behalf.
    expect(events(peerId).some((e) => e.type === "permission_response")).toBe(false);
    expect(app!.sessions.get(peerId).status).toBe("waiting_permission");
  });

  it("refuses a peer that has never run, leaving its title untouched", async () => {
    const { spaceId, askerId, peerId } = await boot();
    const before = app!.sessions.get(peerId).title;
    const refused = await app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "q?" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("never run");
    // The title-hijack mutant: routing delivery through SessionService.send would name the peer's
    // session after the QUESTION rather than its own work.
    expect(app!.sessions.get(peerId).title).toBe(before);
    expect(userMessages(peerId)).toHaveLength(0);
  });

  it("refuses self-ask, an unknown session, a cross-space peer, and an oversized question", async () => {
    const { spaceId, askerId, peerId, spaces, profileId } = await boot();
    await startPeerWorking(peerId);
    expect(text(await app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: askerId, question: "q" }))).toContain("cannot ask itself");
    expect(text(await app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: "nope", question: "q" }))).toContain("does not exist");

    const other = spaces.create({ profileId, name: "Other", icon: "folder" });
    const stranger = app!.sessions.create({ spaceId: other.id, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" }).session;
    expect(text(await app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: stranger.id, question: "q" }))).toContain("another space");

    // The 2000-char cap is the ONLY bound on how much of the asker's framing permanently enters the
    // peer's context, so it must refuse before delivering rather than truncating.
    const huge = await app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "x".repeat(2001) });
    expect(huge.isError).toBe(true);
    expect(text(huge)).toContain("invalid arguments");
    expect(userMessages(peerId).some((e) => e.payload.text.includes("xxxx"))).toBe(false);
  });

  it("only the session a question was ASKED OF may answer it", async () => {
    const { spaceId, askerId, peerId, mk } = await boot({ budgetMs: 30_000 });
    const bystander = mk();
    await startPeerWorking(peerId);
    const pending = app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "q?" });
    const requestId = await requestIdIn(peerId);

    const stolen = app!.asks.answer({ sessionId: bystander.id, spaceId }, { requestId, answer: "I am not the peer" });
    expect(stolen.isError).toBe(true);
    expect(text(stolen)).toContain("not asked of this session");
    // And the asker is STILL waiting — a wrong answerer must not resolve the wait.
    const real = app!.asks.answer({ sessionId: peerId, spaceId }, { requestId, answer: "the real answer" });
    expect(real.isError).toBe(false);
    expect(text(await pending)).toContain("the real answer");
  });
});

describe("delivery is not a `send`", () => {
  it("takes NO checkpoint for the injected question", async () => {
    const { spaceId, askerId, peerId } = await boot();
    await startPeerWorking(peerId);
    const env = app!.sessions.get(peerId).environmentId!;
    const before = app!.db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE environment_id = ?").get(env) as { n: number };

    const pending = app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "q?" });
    const requestId = await requestIdIn(peerId);
    app!.asks.answer({ sessionId: peerId, spaceId }, { requestId, answer: "a" });
    await pending;

    const after = app!.db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE environment_id = ?").get(env) as { n: number };
    // Kills routing delivery through SessionService.send: that would capture a checkpoint MID-EDIT
    // (the peer may be halfway through writing files) and add one per question to the list.
    expect(after.n).toBe(before.n);
  });

  it("never mistakes the peer's PRE-EXISTING output for a reply to the question", async () => {
    // Found by this suite, not by review. Interrupting a busy peer ends its turn, so an `idle` arrives
    // carrying assistant text from the work it was doing BEFORE it was asked anything. Without the
    // turn-boundary rule in the engine's scan, the act of interrupting is itself read as an answer,
    // and the asker is handed a fragment of the peer's unrelated work as its "reply".
    const { spaceId, askerId, peerId } = await boot({
      budgetMs: 30_000, delayMs: 20,
      script: [
        { on: "MY OWN TASK", emit: Array.from({ length: 40 }, (_, i) => ({ kind: "text" as const, text: `UNRELATED WORK ${i}` })) },
        { on: "[Realm]", emit: [{ kind: "text", text: "THE REAL ANSWER" }] },
      ],
    });
    await startPeerWorking(peerId);
    const result = await app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "q?" });
    expect(result.isError).toBe(false);
    const out = text(result);
    expect(out).toContain("THE REAL ANSWER");
    expect(out).not.toContain("UNRELATED WORK");
  });

  it("falls back to a settled peer's final message rather than hanging, and says so", async () => {
    const { spaceId, askerId, peerId } = await boot({ budgetMs: 30_000 });
    // This peer's script answers in prose and settles; it never calls agent_answer.
    await app!.sessions.send(peerId, { text: "PROSE PEER", attachments: [] });
    await waitFor(() => app!.sessions.get(peerId).status === "idle");
    const result = await app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: "q?" });
    expect(result.isError).toBe(false);
    const out = text(result);
    // Kills dropping the fallback, which would hang the asker for the whole budget on any peer that
    // replies in prose — and the label is what lets the asker weigh a guess as a guess.
    expect(out).toContain('"answeredVia":"final-message"');
    expect(out).toContain("replied in prose and settled");
  });
});

describe("consent — Realm's own prompt, on the asker", () => {
  const askIn = (spaceId: string, askerId: string, peerId: string, q = "q?") =>
    app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: peerId, question: q });
  const cardOn = (id: string) => events(id).filter((e) => e.type === "permission_request") as Extract<ReturnType<typeof events>[number], { type: "permission_request" }>[];

  it("raises a card on the ASKER naming the peer, and a denial delivers nothing", async () => {
    const { spaceId, askerId, peerId } = await boot({ askerMode: "default", budgetMs: 30_000 });
    await startPeerWorking(peerId);
    const pending = askIn(spaceId, askerId, peerId);
    await waitFor(() => cardOn(askerId).length === 1);
    const card = cardOn(askerId)[0]!;
    // The card reads `agent_ask`, not the `agent_ask:<ULID>` grant key — the display name and the
    // remembered key are deliberately different values.
    expect(card.payload.toolName).toBe(AGENT_ASK_TOOL_NAME);
    expect(card.payload.title).toContain(app!.sessions.get(peerId).title);
    // Nothing on the peer's pane: the prompt belongs where the blocked call is, and there is one user.
    expect(cardOn(peerId)).toHaveLength(0);

    app!.sessions.respondPermission(askerId, card.payload.requestId, "deny");
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(userMessages(peerId).some((e) => e.payload.text.includes("q?"))).toBe(false);
  });

  it("bypassPermissions asks no card at all", async () => {
    const { spaceId, askerId, peerId } = await boot({ askerMode: "bypassPermissions", budgetMs: 30_000 });
    await startPeerWorking(peerId);
    const pending = askIn(spaceId, askerId, peerId);
    const requestId = await requestIdIn(peerId);
    expect(cardOn(askerId)).toHaveLength(0);
    app!.asks.answer({ sessionId: peerId, spaceId }, { requestId, answer: "a" });
    await pending;
  });

  it("plan mode refuses without a card — interrupting another session is an action, not a read", async () => {
    const { spaceId, askerId, peerId } = await boot({ askerMode: "plan" });
    await startPeerWorking(peerId);
    const refused = await askIn(spaceId, askerId, peerId);
    // Interrupting another session is an action on the world, and a read-only session does not act.
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("Plan");
    expect(cardOn(askerId)).toHaveLength(0);
    expect(userMessages(peerId).some((e) => e.payload.text.includes("q?"))).toBe(false);
  });

  it("allow_always is scoped to the (asker, peer) PAIR — a different peer asks again", async () => {
    const { spaceId, askerId, peerId, mk } = await boot({ askerMode: "default", budgetMs: 30_000 });
    const other = mk();
    await startPeerWorking(peerId);
    await startPeerWorking(other.id);

    const first = askIn(spaceId, askerId, peerId, "one");
    await waitFor(() => cardOn(askerId).length === 1);
    app!.sessions.respondPermission(askerId, cardOn(askerId)[0]!.payload.requestId, "allow_always");
    app!.asks.answer({ sessionId: peerId, spaceId }, { requestId: await requestIdIn(peerId), answer: "a" });
    await first;

    // Same peer again: remembered, no second card.
    const second = askIn(spaceId, askerId, peerId, "two");
    const rid2 = await requestIdIn(peerId);
    expect(cardOn(askerId)).toHaveLength(1);
    app!.asks.answer({ sessionId: peerId, spaceId }, { requestId: rid2, answer: "b" });
    await second;

    // A DIFFERENT peer: asked again. Kills keying the grant on the session alone, which would let one
    // approval silently license interrupting every session in the space.
    const third = askIn(spaceId, askerId, other.id, "three");
    await waitFor(() => cardOn(askerId).length === 2);
    app!.sessions.respondPermission(askerId, cardOn(askerId)[1]!.payload.requestId, "allow");
    app!.asks.answer({ sessionId: other.id, spaceId }, { requestId: await requestIdIn(other.id), answer: "c" });
    await third;
  });
});

describe("depth-1: a delegated agent can neither ask nor be asked", () => {
  it("hides all three tools from a delegated child and refuses every one of them on call", async () => {
    const { spaceId, askerId, peerId } = await boot({
      budgetMs: 30_000, delayMs: 20,
      script: [...PEER_SCRIPT, { on: "You are a delegated agent.", emit: Array.from({ length: 60 }, (_, i) => ({ kind: "text" as const, text: `child ${i}` })) }],
    });
    const running = app!.agentRuns.run({ sessionId: peerId, spaceId }, { goal: "a long job" });
    await waitFor(() => app!.sessions.list(spaceId).length === 3);
    const child = app!.sessions.list(spaceId).find((s) => s.id !== askerId && s.id !== peerId)!;
    const ctx = { sessionId: child.id, spaceId };

    // A partial list is the realistic mutant, so every tool is named individually.
    for (const r of [app!.asks.peers(ctx), app!.asks.answer(ctx, { requestId: "x", answer: "y" }), await app!.asks.ask(ctx, { sessionId: askerId, question: "q" })]) {
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("depth-1");
    }
    // And it is not a valid TARGET either: its parent is blocked inside an MCP call waiting for it.
    const atChild = await app!.asks.ask({ sessionId: askerId, spaceId }, { sessionId: child.id, question: "q" });
    expect(text(atChild)).toContain("delegated agent working on one goal");
    await running;
  });

  it("agent_peers lists the space's other sessions with an askable verdict and a reason for each refusal", async () => {
    const { spaceId, askerId, peerId } = await boot();
    const rows = JSON.parse(text(app!.asks.peers({ sessionId: askerId, spaceId }))) as { sessionId: string; askable: boolean; reason: string | null }[];
    // Itself is never listed; the never-run peer is listed but not askable, with the reason stated —
    // the list and the refusal come from one function so they cannot disagree.
    expect(rows.map((r) => r.sessionId)).toEqual([peerId]);
    expect(rows[0]!.askable).toBe(false);
    expect(rows[0]!.reason).toContain("never run");

    await startPeerWorking(peerId);
    const after = JSON.parse(text(app!.asks.peers({ sessionId: askerId, spaceId }))) as { askable: boolean; reason: string | null }[];
    expect(after[0]!.askable).toBe(true);
    expect(after[0]!.reason).toBeNull();
  });

  it("exposes exactly the three tool names", () => {
    expect([AGENT_ASK_TOOL_NAME, AGENT_ANSWER_TOOL_NAME, AGENT_PEERS_TOOL_NAME]).toEqual(["agent_ask", "agent_answer", "agent_peers"]);
  });
});
