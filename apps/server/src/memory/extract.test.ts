import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { memoryLearningKey, sessionEvent, type Session, type SessionEvent, type StoredSessionEvent } from "@realm/contracts";
import type { MemoryExtractionInput } from "@realm/adapters";
import { RpcError } from "../store/rows";
import {
  LEARN_AFTER_IDLE_MS, LEARN_MIN_USER_TURNS, LEARN_TRANSCRIPT_MAX, LEARNED_AUTHOR, SessionLearner, conversationText, parseLearnedAnswer, savesMemory,
  type SessionLearnerDeps,
} from "./extract";
import type { LearnedCursor } from "./extract-cursor";
import type { MemorySink, SpaceFolder } from "./sink";

let seq = 0;
const stored = (event: SessionEvent, sessionId = "s1"): StoredSessionEvent => ({ seq: ++seq, sessionId, event });
const user = (text: string, extra: Record<string, unknown> = {}) => stored(sessionEvent("user_message", { text, attachments: [], ...extra }));
const assistant = (text: string) => stored(sessionEvent("assistant_text", { messageId: `m${seq}`, text }));
const call = (name: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  stored(sessionEvent("tool_call", { toolUseId: `t${seq}`, name, input, parentToolUseId: null, ...extra }));
const result = (content: string) => stored(sessionEvent("tool_result", { toolUseId: `t${seq}`, content, isError: false }));
const status = (s: "idle" | "running") => stored(sessionEvent("status", { status: s }));
/** Two turns of the person's, each answered: the least a quiet session needs before it is read. */
const exchange = () => [user("Dana owns billing"), assistant("Noted."), user("Invoices go out on the 1st"), assistant("Got it.")];

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1", spaceId: "sp1", projectId: null, agentKind: "claude", model: null, effort: null, permissionMode: "default", fastMode: false,
  environmentId: "e1", cwd: "/work", status: "idle", providerSessionId: null, title: "Billing cleanup", lastEventSeq: seq, seenSeq: 0,
  terminalItemId: null, dispatchedBy: null, activityAt: 0, createdAt: 0, updatedAt: 0, ...over,
});

const answer = (memories: unknown[]) => JSON.stringify({ memories });
const spaceFact = (over: Record<string, unknown> = {}) => ({
  scope: "space", type: "project", name: "billing-owner", description: "Who owns billing", body: "Dana owns billing; ask her before changing invoices.", ...over,
});
const profileFact = (over: Record<string, unknown> = {}) => ({
  scope: "profile", type: "feedback", name: "small-prs", description: "Prefers small PRs", body: "Keep pull requests small; big ones sit unreviewed.", ...over,
});

const outcome = (file = "x.md") => ({ changed: true, file, line: null, sha: "abc", diff: "" });

/** A sink over a real scratch folder (so the indexes the learner reads are files), recording every write. */
function fakeSink(o: { active?: boolean } = {}) {
  const repoPath = tempDir("realm-learn-repo-");
  const dir = join(repoPath, "spaces", "billing");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(repoPath, "MEMORY.md"), "# Memory\n\n- Works in TypeScript\n\n## Index\n- [[spaces/billing/MEMORY]]\n");
  writeFileSync(join(dir, "MEMORY.md"), "- [Deploy steps](deploy-steps.md) — how billing ships\n");
  const place: SpaceFolder = { owner: { scope: "profile", id: "p1" }, repoPath, folder: "billing", dir };
  const writes: string[] = [];
  const saved: Parameters<MemorySink["saveSpaceMemory"]>[1][] = [];
  const batches: { writes: Map<string, string | null>; message: string; author?: string }[] = [];
  const edits: Parameters<MemorySink["edit"]>[1][] = [];
  let editFails: ((o: Parameters<MemorySink["edit"]>[1]) => Error | null) | null = null;
  const sink: MemorySink = {
    spaceFolderFor: vi.fn(() => (o.active === false ? null : place)),
    writeBatch: vi.fn(async (_owner, w, message, author) => { writes.push("batch"); batches.push({ writes: w, message, author }); return outcome(); }),
    saveSpaceMemory: vi.fn(async (_spaceId, m) => { writes.push(`space:${m.name}`); saved.push(m); return outcome(`spaces/billing/${m.name}.md`); }),
    edit: vi.fn(async (_owner, e) => {
      const err = editFails?.(e);
      if (err) throw err;
      writes.push(`edit:${e.op}`); edits.push(e); return outcome("MEMORY.md");
    }),
  };
  return { sink, place, writes, saved, batches, edits, failEdit: (f: typeof editFails) => { editFails = f; } };
}

function build(events: StoredSessionEvent[], o: Partial<SessionLearnerDeps> & { session?: Partial<Session>; reply?: string; stored?: Record<string, unknown>; active?: boolean } = {}) {
  const { session: row, reply, stored: settings = {}, active, ...over } = o;
  const rows = new Map<string, Session>([["s1", session({ lastEventSeq: events.at(-1)?.seq ?? 0, ...row })]]);
  const cursors = new Map<string, LearnedCursor>();
  const store = fakeSink({ active });
  const generate = vi.fn(async (_i: MemoryExtractionInput) => reply ?? answer([]));
  const listOfTypes = vi.fn((sessionId: string, types: readonly SessionEvent["type"][], opts: { afterSeq?: number; limit: number }) => {
    const mine = events.filter((e) => e.sessionId === sessionId && types.includes(e.event.type));
    return opts.afterSeq !== undefined ? mine.filter((e) => e.seq > opts.afterSeq!).slice(0, opts.limit) : mine.slice(-opts.limit);
  });
  const errors: string[] = [];
  const deps: SessionLearnerDeps = {
    sessions: { get: (id) => rows.get(id) ?? null },
    events: { listOfTypes },
    cursors: {
      get: (id) => cursors.get(id) ?? null,
      advance: (id, throughSeq, agentSaved) => {
        const c = cursors.get(id);
        cursors.set(id, { throughSeq: Math.max(c?.throughSeq ?? 0, throughSeq), agentSaved: (c?.agentSaved ?? false) || agentSaved });
      },
    },
    sink: store.sink,
    settings: { get: (k) => settings[k] ?? null },
    profileIdOf: () => "p1",
    carriesAgentContext: () => false,
    generate,
    onError: (line) => errors.push(line),
    ...over,
  };
  return { learner: new SessionLearner(deps), generate: (over.generate as typeof generate | undefined) ?? generate, rows, cursors, events, errors, listOfTypes, ...store };
}

describe("parseLearnedAnswer — the model's answer is JSON of one shape, or nothing is written", () => {
  it("reads up to five memories", () => {
    const r = parseLearnedAnswer(answer([spaceFact(), profileFact()]));
    expect(r).toMatchObject({ ok: true, memories: [{ scope: "space", name: "billing-owner" }, { scope: "profile", name: "small-prs" }] });
  });

  it("takes an empty list — the usual answer", () => {
    expect(parseLearnedAnswer(answer([]))).toEqual({ ok: true, memories: [] });
  });

  it("forgives a markdown fence round the JSON, and nothing else", () => {
    expect(parseLearnedAnswer("```json\n" + answer([spaceFact()]) + "\n```").ok).toBe(true);
    expect(parseLearnedAnswer(`Here is what I found:\n${answer([spaceFact()])}`)).toEqual({ ok: false, error: "the answer is not JSON" });
  });

  it("refuses six memories rather than keeping five of them", () => {
    const six = Array.from({ length: 6 }, (_, i) => spaceFact({ name: `fact-${i}` }));
    expect(parseLearnedAnswer(answer(six)).ok).toBe(false);
  });

  it.each([
    ["a name that is not a slug", spaceFact({ name: "Billing Owner" })],
    ["a description over two lines", spaceFact({ description: "Who owns\nbilling" })],
    ["an empty body", spaceFact({ body: "  " })],
    ["an unknown scope", spaceFact({ scope: "team" })],
    ["an unknown type", spaceFact({ type: "todo" })],
    ["a missing field", { scope: "space", type: "project", name: "x", body: "y" }],
  ])("refuses %s", (_what, item) => {
    expect(parseLearnedAnswer(answer([item])).ok).toBe(false);
  });

  it("reads a null `replaces` as absent", () => {
    const r = parseLearnedAnswer(answer([spaceFact({ replaces: null })]));
    expect(r.ok && r.memories[0]!.replaces).toBeUndefined();
  });
});

describe("conversationText — what the model is shown", () => {
  it("is the person's and the agent's words, without tool calls, their output or anything Realm said", () => {
    const events = [
      user("why do invoices double-send?"),
      call("Bash", { command: "grep -r invoice" }), result("SECRET-LOOKING TOOL OUTPUT"),
      stored(sessionEvent("thinking", { messageId: "m", text: "private reasoning" })),
      assistant("The retry fires twice."),
      user("continue the goal", { goal: "continuation" }),
      user("a note from another session", { from: { sessionId: "s9", title: "Other" } }),
      user("nightly task text", { scheduled: { task: "Nightly", note: "unattended rules" } }),
      status("idle"),
    ];
    const r = conversationText(events);
    expect(r.text).toBe("User: why do invoices double-send?\nAssistant: The retry fires twice.");
    expect(r.userTurns).toBe(1);
  });

  it("keeps the most recent part of a long session, never more than the cap", () => {
    const events = [user(`OLDEST ${"a".repeat(30_000)}`), assistant("b".repeat(20_000)), user("the newest thing said")];
    const r = conversationText(events);
    expect(r.text.length).toBeLessThanOrEqual(LEARN_TRANSCRIPT_MAX);
    expect(r.text.endsWith("User: the newest thing said")).toBe(true);
    expect(r.text).not.toContain("OLDEST");
  });
});

describe("savesMemory — whether the session's own agent already saved", () => {
  const dir = "/repo/spaces/billing";
  it.each([
    ["Claude's realm-memory save", call("mcp__realm__realm-memory__memory_save", { entry: "x" })],
    ["a bare memory_write_file", call("memory_write_file", { link: "x" })],
    ["Claude's own auto-memory write into the folder", call("Write", { file_path: `${dir}/billing-owner.md` })],
    ["an ACP edit naming the folder", call("Edit the file", {}, { kind: "edit", paths: [`${dir}/MEMORY.md`] })],
  ])("counts %s", (_what, e) => { expect(savesMemory(e.event, dir)).toBe(true); });

  it.each([
    ["a write elsewhere", call("Write", { file_path: "/repo/src/index.ts" })],
    ["a read of the folder", call("Read", { file_path: `${dir}/MEMORY.md` })],
    ["a sibling folder that shares the prefix", call("Write", { file_path: "/repo/spaces/billing-old/x.md" })],
    ["a memory read", call("mcp__realm__realm-memory__memory_read", { link: "x" })],
  ])("does not count %s", (_what, e) => { expect(savesMemory(e.event, dir)).toBe(false); });
});

describe("SessionLearner — when it reads a session", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const settle = (l: SessionLearner, before: Partial<Session> = {}) =>
    l.handleSessionEvent(session({ status: "running", ...before }), sessionEvent("status", { status: "idle" }));

  it("reads a session once it has been quiet for ten minutes after a turn", async () => {
    const t = build(exchange());
    settle(t.learner);
    await vi.advanceTimersByTimeAsync(LEARN_AFTER_IDLE_MS - 1);
    expect(t.generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(t.generate).toHaveBeenCalledTimes(1);
  });

  it("re-arms on each settle, so a back-and-forth is read once, after it", async () => {
    const t = build(exchange());
    for (let i = 0; i < 4; i++) { settle(t.learner); await vi.advanceTimersByTimeAsync(LEARN_AFTER_IDLE_MS / 2); }
    expect(t.generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LEARN_AFTER_IDLE_MS);
    expect(t.generate).toHaveBeenCalledTimes(1);
  });

  it("does not read a session that is working again when the wait ends", async () => {
    const t = build(exchange());
    settle(t.learner);
    t.rows.set("s1", session({ status: "running", lastEventSeq: seq }));
    await vi.advanceTimersByTimeAsync(LEARN_AFTER_IDLE_MS + 1);
    expect(t.generate).not.toHaveBeenCalled();
  });

  it("arms only on a settle — not on a fresh engine's first idle, nor on idle repeated", async () => {
    const t = build(exchange());
    settle(t.learner, { status: "ended" });
    settle(t.learner, { status: "idle" });
    t.learner.handleSessionEvent(session({ status: "idle" }), sessionEvent("status", { status: "running" }));
    await vi.advanceTimersByTimeAsync(LEARN_AFTER_IDLE_MS * 2);
    expect(t.generate).not.toHaveBeenCalled();
  });

  it("reads an archived session at once, even with a single new turn, and drops its pending timer", async () => {
    const t = build([user("Dana owns billing"), assistant("Noted.")]);
    settle(t.learner);
    t.learner.sessionArchived("s1");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LEARN_AFTER_IDLE_MS * 2);
    expect(t.generate).toHaveBeenCalledTimes(1);
  });

  it("leaves a quiet session with a single new turn of the person's unread", async () => {
    expect(LEARN_MIN_USER_TURNS).toBe(2);
    const t = build([user("Dana owns billing"), assistant("Noted."), call("Bash"), assistant("Also checked the logs.")]);
    settle(t.learner);
    await vi.advanceTimersByTimeAsync(LEARN_AFTER_IDLE_MS + 1);
    expect(t.generate).not.toHaveBeenCalled();
    expect(await t.learner.learn("s1")).toEqual({ ran: false, why: "too few new user turns" });
    expect(t.cursors.get("s1")).toBeUndefined();
  });

  it("stops every timer on close", async () => {
    const t = build(exchange());
    settle(t.learner);
    t.learner.close();
    await vi.advanceTimersByTimeAsync(LEARN_AFTER_IDLE_MS * 2);
    expect(t.generate).not.toHaveBeenCalled();
  });
});

describe("SessionLearner — the read cursor", () => {
  it("reads only what came since the last pass, and moves past all of it", async () => {
    const events = [user("first ask"), assistant("first answer"), user("second ask"), assistant("second answer")];
    const t = build(events);
    await t.learner.learn("s1");
    expect(t.generate.mock.calls[0]![0].transcript).toBe("User: first ask\nAssistant: first answer\nUser: second ask\nAssistant: second answer");
    expect(t.cursors.get("s1")).toEqual({ throughSeq: events.at(-1)!.seq, agentSaved: false });

    events.push(user("third ask"), assistant("third answer"), user("fourth ask"));
    t.rows.set("s1", session({ lastEventSeq: events.at(-1)!.seq }));
    await t.learner.learn("s1");
    expect(t.generate.mock.calls[1]![0].transcript).toBe("User: third ask\nAssistant: third answer\nUser: fourth ask");
  });

  it("makes no call when nothing is new", async () => {
    const t = build(exchange());
    await t.learner.learn("s1");
    expect(await t.learner.learn("s1")).toEqual({ ran: false, why: "nothing new" });
    expect(t.generate).toHaveBeenCalledTimes(1);
  });

  it("does not claim an event written after the pass began", async () => {
    const events = exchange();
    const t = build(events);
    const upTo = events.at(-1)!.seq;
    events.push(user("typed while the pass ran")); // in the log, but past the row's lastEventSeq
    await t.learner.learn("s1");
    expect(t.generate.mock.calls[0]![0].transcript).not.toContain("typed while");
    expect(t.cursors.get("s1")!.throughSeq).toBe(upTo);
  });

  it("makes no call when only the agent spoke since — learning follows the person's turns", async () => {
    const events = exchange();
    const t = build(events);
    await t.learner.learn("s1");
    events.push(assistant("a follow-up nobody asked for"), user("relayed", { from: { sessionId: "s2", title: "x" } }));
    t.rows.set("s1", session({ lastEventSeq: events.at(-1)!.seq }));
    expect(await t.learner.learn("s1", { putAway: true })).toEqual({ ran: false, why: "too few new user turns" });
    expect(t.generate).toHaveBeenCalledTimes(1);
  });
});

describe("SessionLearner — what the model is told is already known", () => {
  it("hands over the profile's root index and the space's own, read from the repo", async () => {
    const t = build(exchange());
    await t.learner.learn("s1");
    const known = t.generate.mock.calls[0]![0].known;
    expect(known.map((k) => k.index)).toEqual([
      "# Memory\n\n- Works in TypeScript\n\n## Index\n- [[spaces/billing/MEMORY]]\n",
      "- [Deploy steps](deploy-steps.md) — how billing ships\n",
    ]);
    expect(known[1]!.label).toContain("spaces/billing/MEMORY.md");
  });

  it("says whether the session's own agent saved memory — and keeps saying it once the save is behind the cursor", async () => {
    const events = [user("remember Dana owns billing"), call("mcp__realm__realm-memory__memory_save", { entry: "Dana owns billing" }), assistant("Saved."), user("thanks"), assistant("Sure.")];
    const t = build(events);
    await t.learner.learn("s1");
    expect(t.generate.mock.calls[0]![0].agentSaved).toBe(true);
    events.push(user("and invoices go out on the 1st"), assistant("Got it."), user("from Stripe"), assistant("Noted."));
    t.rows.set("s1", session({ lastEventSeq: events.at(-1)!.seq }));
    await t.learner.learn("s1");
    expect(t.generate.mock.calls[1]![0].agentSaved).toBe(true);
  });

  it("says no when the agent saved nothing", async () => {
    const t = build([...exchange(), call("Write", { file_path: "/work/src/a.ts" }), assistant("b")]);
    await t.learner.learn("s1");
    expect(t.generate.mock.calls[0]![0].agentSaved).toBe(false);
  });
});

describe("SessionLearner — a bad answer or a failed call writes nothing, and is not retried", () => {
  it("refuses a malformed answer, writes nothing, and does not read the same text again", async () => {
    const t = build(exchange(), { reply: "I think the user likes pnpm." });
    expect(await t.learner.learn("s1")).toEqual({ ran: true, written: 0, rejected: "the answer is not JSON" });
    expect(t.writes).toEqual([]);
    expect(await t.learner.learn("s1")).toEqual({ ran: false, why: "nothing new" });
    expect(t.generate).toHaveBeenCalledTimes(1);
  });

  it("refuses an answer that breaks the schema, even when part of it is fine", async () => {
    const t = build(exchange(), { reply: answer([spaceFact(), spaceFact({ name: "Not A Slug" })]) });
    const r = await t.learner.learn("s1");
    expect(r).toMatchObject({ ran: true, written: 0 });
    expect(t.writes).toEqual([]);
  });

  it("leaves the cursor where it was when the call itself fails, for the next quiet spell to try", async () => {
    const t = build(exchange(), { generate: vi.fn(async () => { throw new Error("network"); }) });
    expect(await t.learner.learn("s1")).toEqual({ ran: false, why: "the call failed" });
    expect(t.cursors.get("s1")).toBeUndefined();
    expect(t.errors.join("\n")).toContain("network");
  });

  it("turns itself off for the process when the machine cannot make the call", async () => {
    const available = vi.fn(async () => false);
    const t = build(exchange(), { available });
    expect(await t.learner.learn("s1")).toEqual({ ran: false, why: "no model on this machine" });
    expect(await t.learner.learn("s1")).toEqual({ ran: false, why: "no model on this machine" });
    expect(available).toHaveBeenCalledTimes(1);
    expect(t.generate).not.toHaveBeenCalled();
  });
});

describe("SessionLearner — where each memory goes", () => {
  it("saves a space memory into the space's folder, from Realm, naming the session", async () => {
    const t = build(exchange(), { reply: answer([spaceFact()]) });
    expect(await t.learner.learn("s1")).toEqual({ ran: true, written: 1 });
    expect(t.saved).toEqual([{ name: "billing-owner", description: "Who owns billing", type: "project", body: "Dana owns billing; ask her before changing invoices.", sessionId: "s1", author: LEARNED_AUTHOR }]);
    expect(t.edits).toEqual([]);
  });

  it("updates a space memory in place when it replaces one that is there", async () => {
    const t = build(exchange(), { reply: answer([spaceFact({ name: "deploy-process", replaces: "deploy-steps" })]) });
    writeFileSync(join(t.place.dir, "deploy-steps.md"), "---\nname: deploy-steps\n---\nold\n");
    await t.learner.learn("s1");
    expect(t.saved[0]!.name).toBe("deploy-steps");
  });

  it("keeps the model's name when what it replaces is not there", async () => {
    const t = build(exchange(), { reply: answer([spaceFact({ name: "deploy-process", replaces: "no-such-fact" })]) });
    await t.learner.learn("s1");
    expect(t.saved[0]!.name).toBe("deploy-process");
  });

  it("puts a one-line fact about the person in the root index as the entry itself", async () => {
    const t = build(exchange(), { reply: answer([profileFact()]) });
    await t.learner.learn("s1");
    expect(t.saved).toEqual([]);
    expect(t.batches).toEqual([]);
    expect(t.edits).toEqual([{ op: "add", entry: "Keep pull requests small; big ones sit unreviewed.", sessionId: "s1", author: LEARNED_AUTHOR }]);
  });

  it("writes a longer one's body to its own file first, then links it from the root entry", async () => {
    const body = "Keep pull requests small.\nBig ones sit unreviewed for days.";
    const t = build(exchange(), { reply: answer([profileFact({ body })]) });
    await t.learner.learn("s1");
    expect(t.writes).toEqual(["batch", "edit:add"]);
    const b = t.batches[0]!;
    expect([...b.writes]).toEqual([["learned/small-prs.md", `# Prefers small PRs\n\n${body}\n`]]);
    expect(b.message).toBe('Realm learned small-prs from session "Billing cleanup" (s1)');
    expect(b.author).toBe(LEARNED_AUTHOR);
    expect(t.edits[0]!.entry).toBe("Prefers small PRs ([[learned/small-prs]])");
  });

  it("replaces the root entry it names, and adds when there is no such entry", async () => {
    const t = build(exchange(), { reply: answer([profileFact({ replaces: "Prefers big PRs" }), profileFact({ name: "tabs", body: "Indent with tabs.", replaces: "Indent with spaces" })]) });
    t.failEdit((e) => (e.op === "replace" && e.match === "Indent with spaces" ? new RpcError("MEMORY_NO_MATCH", "no entry matches") : null));
    await t.learner.learn("s1");
    expect(t.edits.map((e) => [e.op, e.match ?? null, e.entry])).toEqual([
      ["replace", "Prefers big PRs", "Keep pull requests small; big ones sit unreviewed."],
      ["add", null, "Indent with tabs."],
    ]);
  });

  it("never sends something shaped like a secret, and keeps the rest", async () => {
    const t = build(exchange(), { reply: answer([spaceFact({ body: "The key is sk-abcdefghijklmnopqrstuvwxyz123456" }), profileFact()]) });
    expect(await t.learner.learn("s1")).toEqual({ ran: true, written: 1 });
    expect(t.saved).toEqual([]);
    expect(t.edits).toHaveLength(1);
  });

  it("keeps going past a write that fails, and still moves the cursor", async () => {
    const t = build(exchange(), { reply: answer([profileFact(), spaceFact()]) });
    t.failEdit(() => new RpcError("MEMORY_REPO_DIRTY", "uncommitted changes"));
    expect(await t.learner.learn("s1")).toEqual({ ran: true, written: 1 });
    expect(t.saved).toHaveLength(1);
    expect(t.cursors.get("s1")).toBeDefined();
    expect(t.errors.join("\n")).toContain("uncommitted changes");
  });

  it("tells its owner what it saved, so the Memory pages repaint", async () => {
    const onLearned = vi.fn();
    const t = build(exchange(), { reply: answer([spaceFact()]), onLearned });
    await t.learner.learn("s1");
    expect(onLearned).toHaveBeenCalledWith({ owner: { scope: "profile", id: "p1" }, spaceId: "sp1", written: 1 });
  });
});

describe("SessionLearner — the sessions it never reads", () => {
  const skipped = async (over: Parameters<typeof build>[1], why: string) => {
    const t = build(exchange(), { reply: answer([spaceFact()]), ...over });
    expect(await t.learner.learn("s1")).toEqual({ ran: false, why });
    expect(t.generate).not.toHaveBeenCalled();
    expect(t.writes).toEqual([]);
    return t;
  };

  it("skips the scripted agent", async () => { await skipped({ session: { agentKind: "fake" } }, "scripted agent"); });
  it.each(["agent_run", "browser_agent_run", "review", "run"] as const)("skips a session dispatched by %s", async (kind) => {
    await skipped({ session: { dispatchedBy: { sessionId: null, kind } } }, "delegated");
  });
  it("skips any session that was started with a brief of its own", async () => { await skipped({ carriesAgentContext: () => true }, "delegated"); });
  it("reads a session the person dispatched themselves", async () => {
    const t = build(exchange(), { session: { dispatchedBy: { sessionId: null, kind: "user-dispatch" } } });
    expect((await t.learner.learn("s1")).ran).toBe(true);
  });
  it("skips a profile that turned learning off", async () => { await skipped({ stored: { [memoryLearningKey("p1")]: false } }, "off"); });
  it("skips a space with no profile", async () => { await skipped({ profileIdOf: () => null }, "off"); });
  it("skips a space whose memory is not in use", async () => {
    const t = await skipped({ active: false }, "no memory in this space");
    expect(t.sink.spaceFolderFor).toHaveBeenCalledTimes(1);
  });
  it("does not even look for the space's folder when the session is skipped earlier", async () => {
    const t = await skipped({ session: { agentKind: "fake" } }, "scripted agent");
    expect(t.sink.spaceFolderFor).not.toHaveBeenCalled();
  });
});
