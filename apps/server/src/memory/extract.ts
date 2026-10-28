import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  MEMORY_REPO_INDEX_FILE, MEMORY_REPO_INDEX_MAX, memoryLearningKey, memoryLearningOn, wikiLinkFor,
  type DispatchKind, type Session, type SessionEvent, type StoredSessionEvent,
} from "@realm/contracts";
import type { MemoryExtractionInput } from "@realm/adapters";
import { RpcError } from "../store/rows";
import { claudeFactFile } from "./claude-facts";
import type { LearnedCursor } from "./extract-cursor";
import type { RepoOwner } from "./repo";
import { secretShapeIn } from "./secret-shapes";
import type { MemorySink, SpaceFolder } from "./sink";

/** How long a session stays quiet after a turn before Realm reads it. Long enough that a working
 *  back-and-forth is read once, after it, rather than once per turn. */
export const LEARN_AFTER_IDLE_MS = 10 * 60_000;
/** The most of a session's text one extraction reads: the most recent part, when there is more. */
export const LEARN_TRANSCRIPT_MAX = 40_000;
/** How many new turns of the person's a quiet session needs before it is read. Every read is a call on
 *  the frontier model, and one exchange rarely holds anything a session has not already said; a
 *  session being put away is read whatever it holds, since nothing more is coming. */
export const LEARN_MIN_USER_TURNS = 2;
/** The most memories one extraction may save. */
export const LEARNED_MAX = 5;
/** The name on every commit Realm makes for what it learned. */
export const LEARNED_AUTHOR = "Realm";

/** How many text events are read back from a session's end. Far more than `LEARN_TRANSCRIPT_MAX`
 *  holds in any real session: the cap, not this, decides what the model sees. */
const TEXT_EVENTS_READ = 2_000;
const TOOL_CALLS_READ = 5_000;

/** Sessions an agent or a clock started for one job. What they say is a brief and its execution, not
 *  the person, and their parent session is where the person was. */
const DELEGATED: ReadonlySet<DispatchKind> = new Set(["agent_run", "browser_agent_run", "review", "run"]);

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const oneLine = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\r\n]/.test(s), "must be one line");

/** One memory as the model must answer it. Unknown keys are dropped; a missing or malformed field
 *  fails the whole answer. */
const LearnedMemorySchema = z.object({
  scope: z.enum(["space", "profile"]),
  type: z.enum(["user", "feedback", "project", "reference"]),
  name: z.string().max(64).regex(SLUG, "must be a kebab-case slug"),
  description: oneLine(200),
  body: z.string().trim().min(1).max(4_000),
  replaces: z.string().trim().min(1).max(2_000).nullish().transform((v) => v ?? undefined),
});
export type LearnedMemory = z.infer<typeof LearnedMemorySchema>;

const LearnedAnswerSchema = z.object({ memories: z.array(LearnedMemorySchema).max(LEARNED_MAX) });

/**
 * The model's answer, or why it is refused. JSON only — a markdown fence around it is the one
 * liberty allowed, because a model told "no fence" still adds one now and then and the JSON inside is
 * the same. Anything else, and anything the schema refuses, writes nothing.
 */
export function parseLearnedAnswer(raw: string): { ok: true; memories: LearnedMemory[] } | { ok: false; error: string } {
  const text = raw.trim().replace(/^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/, "$1").trim();
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { ok: false, error: "the answer is not JSON" }; }
  const r = LearnedAnswerSchema.safeParse(json);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    return { ok: false, error: `${issue.path.join(".") || "answer"}: ${issue.message}` };
  }
  return { ok: true, memories: r.data.memories };
}

/**
 * What the person and the agent said, as the model is shown it: user and assistant text only — no tool
 * call or output, no thinking, no status — and only words a person typed on the user side. A message
 * another session delivered (`from`), the goal's own continuations and a scheduled task's text are
 * Realm or an agent talking. Clipped to the most recent `max` characters.
 */
export function conversationText(events: readonly StoredSessionEvent[], max = LEARN_TRANSCRIPT_MAX): { text: string; userTurns: number } {
  const lines: string[] = [];
  let userTurns = 0;
  for (const { event: e } of events) {
    if (e.type === "user_message") {
      if (e.payload.from || e.payload.goal || e.payload.scheduled || !e.payload.text.trim()) continue;
      lines.push(`User: ${e.payload.text.trim()}`);
      userTurns++;
    } else if (e.type === "assistant_text" && e.payload.text.trim()) {
      lines.push(`Assistant: ${e.payload.text.trim()}`);
    }
  }
  return { text: clipToRecent(lines, max), userTurns };
}

/** The last `max` characters of the lines joined, cut at a line where it can be and mid-line only for
 *  the oldest line kept. */
function clipToRecent(lines: string[], max: number): string {
  const kept: string[] = [];
  let room = max;
  for (let i = lines.length - 1; i >= 0 && room > 0; i--) {
    const line = lines[i]!;
    if (line.length + 1 <= room) { kept.unshift(line); room -= line.length + 1; continue; }
    kept.unshift(`…${line.slice(line.length - room + 2)}`);
    break;
  }
  return kept.join("\n");
}

const within = (child: string, parent: string): boolean => {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/** Whether one tool call saved memory: a `realm-memory` write under any engine's spelling of its name,
 *  or a file edit inside the space's memory folder (Claude's own auto-memory, written there). */
export function savesMemory(ev: SessionEvent, dir: string): boolean {
  if (ev.type !== "tool_call") return false;
  const p = ev.payload;
  if (/memory_(?:save|write_file|remove)$/.test(p.name)) return true;
  const edits = ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(p.name) || p.kind === "edit";
  if (!edits) return false;
  const paths = [p.input.file_path, p.input.path, p.input.notebook_path, ...(p.paths ?? [])].filter((x): x is string => typeof x === "string" && x !== "");
  return paths.some((x) => within(resolve(x), resolve(dir)));
}

/** `name`, or the first of `name-2`, `name-3`, … that nothing is saved under yet. */
function unused(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name;
  for (let i = 2; ; i++) if (!taken(`${name}-${i}`)) return `${name}-${i}`;
}

const readIndex = (path: string): string => {
  try { return readFileSync(path, "utf8").slice(0, MEMORY_REPO_INDEX_MAX); } catch { return ""; }
};

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

export type LearnOutcome = { ran: false; why: string } | { ran: true; written: number; rejected?: string };

export type SessionLearnerDeps = {
  sessions: { get(id: string): Session | null };
  events: { listOfTypes(sessionId: string, types: readonly SessionEvent["type"][], opts: { afterSeq?: number; limit: number }): StoredSessionEvent[] };
  cursors: { get(sessionId: string): LearnedCursor | null; advance(sessionId: string, throughSeq: number, agentSaved: boolean, at: number): void };
  sink: MemorySink;
  settings: { get(key: string): unknown };
  profileIdOf: (spaceId: string) => string | null;
  /** Whether the session was started with a brief of its own — a delegated child, a reviewer, an
   *  unattended worker: the sessions whose start carries `agentContext`. */
  carriesAgentContext: (sessionId: string) => boolean;
  /** The billed call. The learner exists only where one is wired (`billedGenerators`). */
  generate: (input: MemoryExtractionInput) => Promise<string>;
  /** Whether this machine can make the call at all. A no turns learning off for the process. */
  available?: () => boolean | Promise<boolean>;
  idleMs?: number;
  now?: () => number;
  /** After a pass that saved something: the Memory pages repaint, and the tidier hears the index grew. */
  onLearned?: (o: { owner: RepoOwner; spaceId: string; written: number }) => void;
  onError?: (line: string) => void;
};

/**
 * Realm's own memory extraction: when a session goes quiet after the person has said a few new things,
 * or is archived, ONE call reads what was said since the last time and saves what is worth keeping
 * into the profile's memory repo — the space's facts into its folder, the person's into the root. It
 * works the same for every engine, because it reads Realm's transcript, not the engine's.
 *
 * What it will not do:
 * - read a session twice: the cursor moves past everything a call was shown, whatever it answered;
 * - retry: a call that fails leaves the cursor where it was for the next quiet spell or archive to
 *   pick up, and an answer that is not valid JSON of the right shape writes nothing at all;
 * - read the scripted agent, a delegated child, a reviewer or a worker;
 * - write where the person turned it off, or where the space has no profile repo in use.
 */
export class SessionLearner {
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlight = new Set<string>();
  private unavailable = false;
  private closed = false;

  constructor(private d: SessionLearnerDeps) {}

  /** The session-event rail (app.ts's fan-out). A turn settling re-arms the session's quiet timer, so a
   *  back-and-forth is read once, after it. `before` is the row as it was before this event. */
  handleSessionEvent(before: Session, ev: SessionEvent): void {
    if (this.closed || ev.type !== "status" || ev.payload.status !== "idle") return;
    // A settle, as the session service reads one: out of a live state, not a fresh engine booting.
    if (before.status === "idle" || before.status === "ended") return;
    const armed = this.pending.get(before.id);
    if (armed) clearTimeout(armed);
    const timer = setTimeout(() => {
      this.pending.delete(before.id);
      // A turn started during the wait settles on its own and re-arms this.
      if (this.d.sessions.get(before.id)?.status !== "idle") return;
      void this.learn(before.id).catch((e) => this.fail(before.id, e));
    }, this.d.idleMs ?? LEARN_AFTER_IDLE_MS);
    timer.unref?.();
    this.pending.set(before.id, timer);
  }

  /** The person put the session away: read it now rather than after the quiet spell. */
  sessionArchived(sessionId: string): void {
    const armed = this.pending.get(sessionId);
    if (armed) { clearTimeout(armed); this.pending.delete(sessionId); }
    void this.learn(sessionId, { putAway: true }).catch((e) => this.fail(sessionId, e));
  }

  close(): void {
    this.closed = true;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  /** One extraction pass. Public for the tests; production reaches it through the two triggers.
   *  `putAway`: the session is being archived, so one new turn is enough. */
  async learn(sessionId: string, o: { putAway?: boolean } = {}): Promise<LearnOutcome> {
    const skip = (why: string): LearnOutcome => ({ ran: false, why });
    if (this.closed) return skip("closed");
    if (this.unavailable) return skip("no model on this machine");
    if (this.inFlight.has(sessionId)) return skip("already reading");
    const s = this.d.sessions.get(sessionId);
    if (!s) return skip("no such session");
    if (s.agentKind === "fake") return skip("scripted agent");
    if ((s.dispatchedBy && DELEGATED.has(s.dispatchedBy.kind)) || this.d.carriesAgentContext(sessionId)) return skip("delegated");
    const profileId = this.d.profileIdOf(s.spaceId);
    if (profileId === null || !memoryLearningOn(this.d.settings.get(memoryLearningKey(profileId)))) return skip("off");

    const cursor = this.d.cursors.get(sessionId) ?? { throughSeq: 0, agentSaved: false };
    // Read up to where the session stood when this pass began: an event landing mid-pass is the next
    // pass's, and the cursor must not claim it.
    const upTo = s.lastEventSeq;
    if (upTo <= cursor.throughSeq) return skip("nothing new");
    const fresh = (e: StoredSessionEvent) => e.seq > cursor.throughSeq && e.seq <= upTo;
    const said = conversationText(this.d.events.listOfTypes(sessionId, ["user_message", "assistant_text"], { limit: TEXT_EVENTS_READ }).filter(fresh));
    if (said.userTurns < (o.putAway ? 1 : LEARN_MIN_USER_TURNS)) return skip("too few new user turns");
    const place = this.d.sink.spaceFolderFor(s.spaceId);
    if (!place) return skip("no memory in this space");

    this.inFlight.add(sessionId);
    try {
      if (this.d.available) {
        let ok = false;
        try { ok = await this.d.available(); } catch { ok = false; }
        if (!ok) { this.unavailable = true; return skip("no model on this machine"); }
      }
      const calls = this.d.events.listOfTypes(sessionId, ["tool_call"], { afterSeq: cursor.throughSeq, limit: TOOL_CALLS_READ }).filter(fresh);
      const agentSaved = cursor.agentSaved || calls.some((c) => savesMemory(c.event, place.dir));
      const known = [
        { label: "About the person, in every space (MEMORY.md)", index: readIndex(join(place.repoPath, MEMORY_REPO_INDEX_FILE)) },
        { label: `This space (spaces/${place.folder}/MEMORY.md)`, index: readIndex(join(place.dir, MEMORY_REPO_INDEX_FILE)) },
      ];
      let raw: string;
      try { raw = await this.d.generate({ transcript: said.text, known, agentSaved }); }
      catch (e) { this.fail(sessionId, e); return skip("the call failed"); }
      if (this.closed) return skip("closed");
      const now = (this.d.now ?? Date.now)();
      const answer = parseLearnedAnswer(raw);
      if (!answer.ok) {
        this.d.onError?.(`[memory] session ${sessionId}: the extraction answer was refused (${answer.error}); nothing saved`);
        this.d.cursors.advance(sessionId, upTo, agentSaved, now);
        return { ran: true, written: 0, rejected: answer.error };
      }
      let written = 0;
      for (const m of answer.memories) {
        try { if (await this.save(s, place, m)) written++; }
        catch (e) { this.fail(sessionId, e); }
      }
      this.d.cursors.advance(sessionId, upTo, agentSaved, now);
      if (written > 0) this.d.onLearned?.({ owner: place.owner, spaceId: s.spaceId, written });
      return { ran: true, written };
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  /**
   * One memory to where it belongs. A space's fact is a file in its folder; a fact about the person
   * is an entry in the root index every space reads — the entry IS the fact when it is one line, and
   * otherwise names it and links a body file written first, so the link never points at nothing.
   * `replaces` updates in place: the space fact of that name, or the root entry with that text. A file
   * already under a name `replaces` does not give is somebody else's — the person's own, or one Claude
   * or an import wrote — and is never written over: the new one is saved beside it, numbered.
   */
  private async save(s: Session, place: SpaceFolder, m: LearnedMemory): Promise<boolean> {
    if (secretShapeIn([m.name, m.description, m.body, m.replaces ?? ""].join("\n"))) return false;
    if (m.scope === "space") {
      const taken = (name: string) => existsSync(join(place.dir, claudeFactFile(name)));
      const name = m.replaces && SLUG.test(m.replaces) && taken(m.replaces) ? m.replaces : unused(m.name, taken);
      const out = await this.d.sink.saveSpaceMemory(s.spaceId, { name, description: m.description, type: m.type, body: m.body, sessionId: s.id, author: LEARNED_AUTHOR });
      return out.changed;
    }
    let entry = m.body;
    if (m.body.includes("\n")) {
      const rel = `learned/${unused(m.name, (name) => existsSync(join(place.repoPath, "learned", `${name}.md`)))}.md`;
      await this.d.sink.writeBatch(place.owner, new Map([[rel, `# ${m.description}\n\n${m.body}\n`]]),
        `Realm learned ${m.name} from session "${clip(s.title, 48)}" (${s.id})`, LEARNED_AUTHOR);
      entry = `${m.description} (${wikiLinkFor(rel)})`;
    }
    const base = { entry, sessionId: s.id, author: LEARNED_AUTHOR };
    if (m.replaces) {
      try { return (await this.d.sink.edit(place.owner, { ...base, op: "replace", match: m.replaces })).changed; }
      catch (e) { if (!(e instanceof RpcError && e.code === "MEMORY_NO_MATCH")) throw e; }
    }
    return (await this.d.sink.edit(place.owner, { ...base, op: "add" })).changed;
  }

  private fail(sessionId: string, e: unknown): void {
    this.d.onError?.(`[memory] session ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
