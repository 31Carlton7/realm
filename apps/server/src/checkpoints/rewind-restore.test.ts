import { describe, expect, it, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tempDir } from "@realm/test-utils";
import { AsyncQueue, type AgentAdapter, type AgentHandle, type StartOptions } from "@realm/adapters";
import { sessionEvent, type SessionEvent } from "@realm/contracts";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { ProjectsStore } from "../store/projects";
import { ItemsStore } from "../store/items";
import { EnvironmentsStore } from "../store/environments";
import { SessionsStore, SessionEventsStore } from "../store/sessions";
import { SettingsStore } from "../store/settings";
import { ArtifactsStore } from "../store/artifacts";
import { CheckpointsStore } from "../store/checkpoints";
import { CheckpointGit } from "../workspace/checkpoints";
import { CheckpointService } from "./service";
import { SessionService } from "../sessions/service";
import { REWIND_REFUSAL_PREFIX, decodeArmedRewind } from "./rewind";
import { waitFor } from "../test-utils";

/**
 * The whole rewind, end to end across the two services that own it: a turn records where the provider's
 * chain stood, a restore cuts Realm's transcript and arms the fork, the next send carries that fork to
 * the adapter — and, when the provider refuses it, the session recovers plainly and never asks again.
 *
 * A hand-built object graph rather than `createApp`, for one reason worth stating: `CheckpointDeps
 * .rewindSession` is the seam under test, and the shipped `createApp` does not wire it yet (see the
 * wiring request). Everything load-bearing here is real — a real repository, a real database, the real
 * `SessionService` and `CheckpointService` — and the stubs are the services this path never touches.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}
function initRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "init");
}

type StartRecord = { resume: string | null | undefined; resumeAt: string | null | undefined; resumeDropsTurn: string | null | undefined };

/**
 * A Claude-shaped adapter: it answers a turn, reports a chain cursor, and can be told to refuse a fork
 * the way the CLI's `--resume-drops-turn` guard does.
 *
 * `kind: "claude"` is load-bearing rather than cosmetic — `AGENT_CONVERSATION_REWIND` is keyed by kind,
 * so the rewind only happens at all for a session claiming to be Claude.
 */
class ChainAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  /** Every start, in order — what the fork actually reached the adapter as. */
  readonly starts: StartRecord[] = [];
  /** Refuse the NEXT forked start, once, the way the CLI does: an error result at fork time. */
  refuseFork = false;
  private turn = 0;
  /** The provider session id the next start reports on `init` — the SDK mints a new one per resume. */
  providerSessionId = "prov-1";

  async probe() { return { kind: this.kind, available: true, version: "test", loggedIn: true, reason: null }; }

  start(opts: StartOptions & { resumeAt?: string | null; resumeDropsTurn?: string | null }): AgentHandle & { chainCursor(): { promptUuid: string | null; endUuid: string | null } } {
    this.starts.push({ resume: opts.resume, resumeAt: opts.resumeAt, resumeDropsTurn: opts.resumeDropsTurn });
    const forked = Boolean(opts.resumeAt && opts.resumeDropsTurn);
    const refusing = forked && this.refuseFork;
    const events = new AsyncQueue<SessionEvent>();
    let cursor = { promptUuid: null as string | null, endUuid: null as string | null };
    events.push(sessionEvent("init", { providerSessionId: this.providerSessionId, model: "m", tools: [], cwd: opts.cwd }));
    events.push(sessionEvent("status", { status: "idle" }));
    return {
      events,
      chainCursor: () => ({ ...cursor }),
      send: async () => {
        if (refusing) {
          // The guard fires at fork time, so the prompt never reaches the model: an error result and a
          // settle, with no assistant output at all. `withStderr` has already wrapped it by the time
          // SessionService sees a real one, which is why the tail is here too.
          this.refuseFork = false;
          events.push(sessionEvent("error", { message: `${REWIND_REFUSAL_PREFIX} a queued user message past the fork point\n--- stderr (last 1 lines) ---\nboom` }));
          events.push(sessionEvent("status", { status: "idle" }));
          return;
        }
        const n = ++this.turn;
        events.push(sessionEvent("status", { status: "running" }));
        events.push(sessionEvent("assistant_text", { messageId: `m${n}`, text: `answer ${n}` }));
        cursor = { promptUuid: `p${n}`, endUuid: `end${n}` };
        events.push(sessionEvent("status", { status: "idle" }));
      },
      respondPermission: () => {},
      interrupt: async () => {},
      setOptions: async () => {},
      dispose: async () => { events.close(); },
    };
  }
}

let db: Db; let home: string; let folder: string; let spaceId: string;
let sessionsStore: SessionsStore; let events: SessionEventsStore; let checkpointsStore: CheckpointsStore;
let checkpoints: CheckpointService; let sessions: SessionService; let adapter: ChainAdapter;
/** Every error failover was told about. A fork refusal must never appear here: the refusal is
 *  deterministic, so anything that retries the turn re-sends a request that can only fail again. */
let failoverErrors: string[];

beforeEach(() => {
  home = tempDir("realm-rewind-");
  if (!resolve(home).startsWith(resolve(tmpdir()))) throw new Error(`refusing to run against ${home}`);
  db = openDatabase(join(home, "realm.db"));
  const profiles = new ProfilesStore(db);
  const spaces = new SpacesStore(db, home);
  const environments = new EnvironmentsStore(db);
  sessionsStore = new SessionsStore(db);
  events = new SessionEventsStore(db);
  checkpointsStore = new CheckpointsStore(db);
  const p = profiles.create({ name: "P", icon: "x", color: "#000" });
  const space = spaces.create({ profileId: p.id, name: "Work", icon: "folder" });
  spaceId = space.id; folder = space.folderPath;
  initRepo(folder);
  adapter = new ChainAdapter();
  failoverErrors = [];

  let sessionService: SessionService | null = null;
  checkpoints = new CheckpointService({
    checkpoints: checkpointsStore, environments, sessions: sessionsStore, git: new CheckpointGit(),
    isEnvironmentBusy: (id) => sessionService?.isEnvironmentBusy(id) ?? false,
    // The wiring request, exercised here: the same late-bound closure `isEnvironmentBusy` uses.
    rewindSession: (input) => sessionService?.rewindConversation(input) ?? false,
  });
  sessions = new SessionService({
    db, rpc: { broadcast: () => {} }, sessions: sessionsStore, events, items: new ItemsStore(db), spaces,
    projects: new ProjectsStore(db), environments, settings: new SettingsStore(db),
    // Everything below is a service this path never reaches: no worktree, no pty, no skills library,
    // no MCP gateway, no memory documents. Stubbed to the one method `ensureLive` calls on each.
    worktrees: {}, ports: { ensureBlock: async () => {} }, terminals: {},
    adapters: { claude: adapter },
    skills: { injectionFor: () => null, wouldInject: () => false },
    gateway: { register: () => ({ name: "realm", transport: "http", url: "http://127.0.0.1:1/mcp", headers: {} }), release: () => {}, realmProvidersFor: () => [] },
    memory: { systemContextFor: () => undefined, sourcesFor: () => ({}) },
    checkpoints,
    failover: {
      turnStarted: () => {}, cancel: () => {}, release: () => {}, close: () => {},
      extraSystemContext: () => undefined,
      onError: (_s: unknown, message: string) => { failoverErrors.push(message); },
    },
  } as never);
  sessionService = sessions;
});

const primary = () => new EnvironmentsStore(db).ensurePrimary(spaceId);
const newSession = () => sessions.create({ spaceId, projectId: null, agentKind: "claude", model: null, effort: null, permissionMode: "default" }).session;
/** Send, and wait for the turn to settle — the moment the chain cursor is read. */
const send = async (id: string, text: string) => {
  await sessions.send(id, { text, attachments: [] });
  await waitFor(() => sessionsStore.get(id)?.status === "idle" && events.lastOfType(id, "assistant_text") !== null);
};
/** Restore is refused while a handle is live, exactly as it is in the app. */
const quiesce = async (id: string) => { await sessions.stopAgent(id); };

describe("restore rewinds the conversation", () => {
  it("cuts Realm's transcript at the checkpoint and carries the fork into the next start", async () => {
    const env = primary();
    const s = newSession();
    await send(s.id, "first");
    const cp = checkpoints.list(env.id, s.id)[0]!; // the checkpoint in front of the SECOND turn is next
    await send(s.id, "second");
    const secondTurn = checkpoints.list(env.id, s.id)[0]!;
    expect(secondTurn.id).not.toBe(cp.id);

    // The agent wrote a file on the second turn, and the transcript grew.
    writeFileSync(join(folder, "second.txt"), "work\n");
    const before = events.listAfter(s.id, 0, 100).map((e) => e.event.type);
    expect(before.filter((t) => t === "user_message")).toHaveLength(2);

    await quiesce(s.id);
    const preview = await checkpoints.preview(secondTurn.id);
    expect(preview.rewindsConversation).toBe(true);
    const result = await checkpoints.restore(secondTurn.id, { filesChanged: preview.filesChanged, commitsRolledBack: preview.commitsRolledBack });
    expect(result.conversationRewound).toBe(true);

    // Realm's transcript ends where the first turn ended…
    const after = events.listAfter(s.id, 0, 100).map((e) => e.event.type);
    expect(after.filter((t) => t === "user_message")).toHaveLength(1);
    expect(sessionsStore.get(s.id)!.lastEventSeq).toBe(secondTurn.sessionSeq);
    expect(existsSync(join(folder, "second.txt"))).toBe(false);

    // …and the provider is asked to end there too, on the very next send.
    await send(s.id, "third");
    expect(adapter.starts.at(-1)).toEqual({ resume: "prov-1", resumeAt: "end1", resumeDropsTurn: "p2" });
  });

  it("truncates Realm's transcript only when the provider is being rewound too", async () => {
    /* The lie this whole feature is written against. A session whose checkpoint carries no provider
       cursor must keep every event: hiding the turns from the reader while the model still carries them
       is worse than admitting the agent remembers. */
    const env = primary();
    const s = newSession();
    await send(s.id, "first");
    const firstTurn = checkpoints.list(env.id, s.id)[0]!;
    await send(s.id, "second");
    expect(firstTurn.providerCursor).toBeNull(); // nothing preceded it; there is nowhere to fork to

    await quiesce(s.id);
    const preview = await checkpoints.preview(firstTurn.id);
    expect(preview.rewindsConversation).toBe(false);
    const result = await checkpoints.restore(firstTurn.id, { filesChanged: preview.filesChanged, commitsRolledBack: preview.commitsRolledBack });
    expect(result.conversationRewound).toBe(false);
    expect(events.listAfter(s.id, 0, 100).filter((e) => e.event.type === "user_message")).toHaveLength(2);
  });

  it("refuses to arm a fork while the session still holds a live handle", async () => {
    // Not redundant with the environment-busy refusal: that one guards the CHECKOUT, this one guards
    // the arm. The fork is honoured at boot, so a live handle would mean a truncated transcript above a
    // conversation nothing is ever going to truncate.
    const env = primary();
    const s = newSession();
    await send(s.id, "first");
    await send(s.id, "second");
    const secondTurn = checkpoints.list(env.id, s.id)[0]!;
    expect(sessions.isLive(s.id)).toBe(true);
    expect(sessions.rewindConversation({ sessionId: s.id, throughSeq: secondTurn.sessionSeq!, fork: "{}" })).toBe(false);
    expect(events.listAfter(s.id, 0, 100).filter((e) => e.event.type === "user_message")).toHaveLength(2);
  });

  it("disarms the fork once a start has carried it, so a later start resumes plainly", async () => {
    const env = primary();
    const s = newSession();
    await send(s.id, "first");
    await send(s.id, "second");
    const secondTurn = checkpoints.list(env.id, s.id)[0]!;
    await quiesce(s.id);
    const preview = await checkpoints.preview(secondTurn.id);
    await checkpoints.restore(secondTurn.id, { filesChanged: preview.filesChanged, commitsRolledBack: preview.commitsRolledBack });
    expect(decodeArmedRewind(sessionsStore.rewindFork(s.id))).toMatchObject({ checkpointId: secondTurn.id });

    await send(s.id, "third");
    expect(sessionsStore.rewindFork(s.id)).toBeNull();
    await quiesce(s.id);
    await send(s.id, "fourth");
    // The mutant: leaving the row armed. The fourth turn would re-fork a chain that has since moved on.
    expect(adapter.starts.at(-1)).toMatchObject({ resumeAt: undefined, resumeDropsTurn: undefined });
  });
});

describe("a provider that refuses the fork", () => {
  /** Restore the second turn, then send — the refusal lands on that send. */
  const restoreAndSend = async () => {
    const env = primary();
    const s = newSession();
    await send(s.id, "first");
    await send(s.id, "second");
    const secondTurn = checkpoints.list(env.id, s.id)[0]!;
    await quiesce(s.id);
    const preview = await checkpoints.preview(secondTurn.id);
    await checkpoints.restore(secondTurn.id, { filesChanged: preview.filesChanged, commitsRolledBack: preview.commitsRolledBack });
    adapter.refuseFork = true;
    await sessions.send(s.id, { text: "third", attachments: [] });
    return { s, secondTurn };
  };

  it("recovers by resuming plainly and re-sending the turn the refusal swallowed", async () => {
    const { s } = await restoreAndSend();
    // The refusal killed the turn before the model saw a word of it. The user's message is not lost:
    // the handle is torn down and the turn goes out again, this time with no fork.
    await waitFor(() => adapter.starts.length >= 3);
    await waitFor(() => events.lastOfType(s.id, "assistant_text") !== null);
    expect(adapter.starts[1]).toMatchObject({ resumeAt: "end1", resumeDropsTurn: "p2" });
    expect(adapter.starts[2]).toMatchObject({ resumeAt: undefined, resumeDropsTurn: undefined });
    // One user_message, not two: the re-send is the same turn, not a new one.
    expect(events.listAfter(s.id, 0, 100).filter((e) => e.event.type === "user_message" && e.event.payload.text === "third")).toHaveLength(1);
  });

  it("keeps the evidence — on the session and on the transcript", async () => {
    const { s } = await restoreAndSend();
    await waitFor(() => sessionsStore.rewindRefusal(s.id) !== null);
    expect(sessionsStore.rewindRefusal(s.id)).toContain(REWIND_REFUSAL_PREFIX);
    // The CLI's diagnostic names what it found past the fork point; Realm has nothing better to say.
    expect(sessionsStore.rewindRefusal(s.id)).toContain("a queued user message past the fork point");
    const errors = events.listAfter(s.id, 0, 200).filter((e) => e.event.type === "error");
    expect(errors).toHaveLength(1);
    /* …and it reached failover from nobody. The refusal is deterministic, so a retry — failover's
       whole job — would re-send a request that can only fail again. The transcript keeps the error;
       the retry machinery is never handed it. */
    expect(failoverErrors).toEqual([]);
  });

  it("never sends the same fork again: the arm is gone and the cursor with it", async () => {
    /* The rule the SDK states outright — the refusal is deterministic, so a retry fails forever.
       Clearing only the session's arm would leave the checkpoint advertising the same doomed fork for
       the next restore to pick up, which is a retry with extra steps. */
    const { s, secondTurn } = await restoreAndSend();
    await waitFor(() => sessionsStore.rewindRefusal(s.id) !== null);
    expect(sessionsStore.rewindFork(s.id)).toBeNull();
    expect(checkpointsStore.require(secondTurn.id).providerCursor).toBeNull();

    await waitFor(() => sessionsStore.get(s.id)?.status === "idle" && adapter.starts.length >= 3);
    await quiesce(s.id);
    const preview = await checkpoints.preview(secondTurn.id);
    expect(preview.rewindsConversation).toBe(false);
    const again = await checkpoints.restore(secondTurn.id, { filesChanged: preview.filesChanged, commitsRolledBack: preview.commitsRolledBack });
    expect(again.conversationRewound).toBe(false);

    const startsBefore = adapter.starts.length;
    await send(s.id, "fourth");
    expect(adapter.starts.slice(startsBefore).every((r) => r.resumeAt === undefined)).toBe(true);
  });
});

/**
 * The transcript truncation itself. Three tables, because `append` writes three and a deletion that
 * left two of them behind would be a different corruption from the one it was fixing: search would go
 * on quoting sentences from turns that no longer exist, and the Library would go on listing their files.
 */
describe("truncating a transcript", () => {
  it("takes the events, their search rows and their indexed files together", () => {
    const artifacts = new ArtifactsStore(db, new SettingsStore(db));
    const indexed = new SessionEventsStore(db, artifacts);
    const s = newSession();
    const kept = indexed.append(s.id, sessionEvent("user_message", { text: "a pangolin question", attachments: [] })).seq;
    indexed.append(s.id, sessionEvent("assistant_text", { messageId: "m1", text: "a pangolin answer" }));
    indexed.append(s.id, sessionEvent("tool_call", { toolUseId: "t1", name: "Write", input: { file_path: join(folder, "report.md") }, parentToolUseId: null }));
    const rows = (sql: string) => (db.prepare(sql).get(s.id) as { n: number }).n;
    expect(rows("SELECT COUNT(*) AS n FROM search_index WHERE kind = 'session' AND ref = ?")).toBe(2);
    expect(rows("SELECT COUNT(*) AS n FROM artifacts WHERE session_id = ?")).toBe(1);

    expect(indexed.truncate(s.id, kept)).toBe(2);

    expect(indexed.listAfter(s.id, 0, 100).map((e) => e.event.type)).toEqual(["user_message"]);
    // The mutant: deleting only `session_events`. Search would keep answering "a pangolin answer" with
    // a seq nothing can open, and the Library would keep offering a file the restore just removed.
    expect(rows("SELECT COUNT(*) AS n FROM search_index WHERE kind = 'session' AND ref = ?")).toBe(1);
    expect(rows("SELECT COUNT(*) AS n FROM artifacts WHERE session_id = ?")).toBe(0);
  });

  it("pulls the read mark back with the transcript", () => {
    // The one write in the sessions store that moves `seen_seq` BACKWARDS, and it has to: a mark past
    // the end of a shortened transcript leaves the session permanently claiming to be read up to an
    // event nobody can open, and `markSeen`'s MAX could never lower it again.
    const s = newSession();
    const kept = events.append(s.id, sessionEvent("user_message", { text: "one", attachments: [] })).seq;
    const last = events.append(s.id, sessionEvent("assistant_text", { messageId: "m1", text: "two" })).seq;
    sessionsStore.markSeen(s.id, last);
    expect(sessionsStore.get(s.id)).toMatchObject({ seenSeq: last });

    events.truncate(s.id, kept);
    expect(sessionsStore.get(s.id)).toMatchObject({ lastEventSeq: kept, seenSeq: kept });
  });

  it("leaves another session's transcript alone", () => {
    const mine = newSession(); const theirs = newSession();
    const kept = events.append(mine.id, sessionEvent("user_message", { text: "mine", attachments: [] })).seq;
    events.append(mine.id, sessionEvent("assistant_text", { messageId: "m1", text: "answered" }));
    events.append(theirs.id, sessionEvent("user_message", { text: "theirs", attachments: [] }));

    events.truncate(mine.id, kept);
    // Seqs are GLOBAL across sessions, so a truncation bounded by seq alone would reach into whatever
    // ran after it elsewhere. The session id is what keeps this to one transcript.
    expect(events.listAfter(theirs.id, 0, 10)).toHaveLength(1);
  });
});
