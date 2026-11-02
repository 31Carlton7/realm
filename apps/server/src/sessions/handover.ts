import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import {
  AGENT_MODELS, AGENT_SUPPORTS_ASK_MODE, AGENT_SUPPORTS_PERMISSION_MODES, AGENT_SUPPORTS_PLAN_MODE, ASK_PERMISSION_MODE, DEFAULT_MODEL_LABEL,
  HANDOFF_CONTEXT_MAX, PERMISSION_MODES, PLAN_PERMISSION_MODE, agentModelName, carriedTranscript, factLines, handoffContextKey,
  sessionEvent, sessionFacts, type AgentKind, type Session, type SessionEvent, type SessionEventPayload,
} from "@realm/contracts";
import type { HandoffNotesInput, ProbeResult } from "@realm/adapters";
import type { SessionsStore, SessionEventsStore } from "../store/sessions";
import type { SettingsStore } from "../store/settings";
import { transcriptForSummary } from "./summary";

/** Where a switch's hand-off notes are kept: `handoffs/<sessionId>/<n>.md`, one per switch, under
 *  Realm's home beside its other folders of its own. */
export const handoffsRoot = (home: string): string => join(home, "handoffs");

/** How much of the end of the conversation a hand-off note quotes as it was written: the last few
 *  turns, which are what the next agent is most likely to be asked about first. */
const LAST_TURNS = 3;
const LAST_TURNS_MAX = 12_000;

export type HandOverDeps = {
  sessions: SessionsStore;
  settings: SettingsStore;
  /** Tear down the live adapter, so the next start is the new agent's. */
  stop: (sessionId: string) => Promise<void>;
  /** Put an event on the session's transcript, down the path the pump uses. */
  emit: (sessionId: string, ev: SessionEvent) => void;
};

/**
 * Move a session onto another agent IN PLACE — failover's handoff and a switch the person asked for
 * are this one move, carrying different words.
 *
 * It answers every clause of the objection `sessions.setAgent` raises once a session has run:
 *
 *  - the `providerSessionId` is CLEARED, so nothing resumes a thread the new agent never had;
 *  - `model` and `effort` are the new agent's, because model ids are per-kind and asking Codex for
 *    `claude-opus-5` is a lie the adapter would have to invent an answer to;
 *  - the conversation so far is carried as TEXT, in the context the next start reads
 *    (`handoffContextKey`), because no adapter can import another vendor's conversation;
 *  - and a `handoff` event is persisted, so the transcript states where the voice changed.
 *
 * Order matters and is load-bearing: the adapter is stopped BEFORE the row is rewritten (a live handle
 * outliving its own `agentKind` would keep pumping the old agent's events into a session that now
 * claims to be another one), and the context is written BEFORE the row moves, because `ensureLive`
 * reads both and must never see one without the other. `stillWanted` is asked once the stop has
 * settled, since the world moves while it runs. Answers whether the move happened.
 */
export async function handOver(d: HandOverDeps, session: Session, move: {
  to: AgentKind; model: string | null; effort: string | null;
  /** Left as they are when absent. */
  permissionMode?: string; accountId?: string | null;
  /** Built once the old adapter is down, so it reads every event that adapter wrote. */
  context: () => string;
  event: SessionEventPayload<"handoff">;
}, stillWanted: () => boolean = () => true): Promise<boolean> {
  await d.stop(session.id);
  if (!stillWanted()) return false;
  d.settings.set(handoffContextKey(session.id), move.context());
  d.sessions.update({
    id: session.id, agentKind: move.to, providerSessionId: null, model: move.model, effort: move.effort,
    ...(move.permissionMode !== undefined ? { permissionMode: move.permissionMode } : {}),
    ...(move.accountId !== undefined ? { accountId: move.accountId } : {}),
  });
  d.emit(session.id, sessionEvent("handoff", move.event));
  return true;
}

/**
 * A session's model by the name the picker gives it: the probe's live catalog first, Realm's curated
 * list after, the bare id where neither knows it, and the agent's own default where nothing is pinned
 * — "Claude Opus 5.5", "Codex GPT-5.6".
 */
export function modelNameOf(kind: AgentKind, model: string | null, probes: readonly ProbeResult[]): string {
  const live = probes.find((p) => p.kind === kind)?.models ?? [];
  const list: readonly { id: string; label: string }[] = live.length > 0 ? live : AGENT_MODELS[kind];
  const found = model !== null ? list.find((m) => m.id === model) : live.find((m) => m.isDefault);
  return agentModelName(kind, found?.label ?? model ?? DEFAULT_MODEL_LABEL[kind]);
}

/**
 * The permission mode a session keeps through a switch: its own where the new agent can be put in it,
 * and otherwise `fallback`, the mode a new session on that agent starts in — a fork's answer, for the
 * fork's reason: each harness names its own modes.
 */
export function modeAfterSwitch(to: AgentKind, mode: string, fallback: string): string {
  const keeps = mode === PLAN_PERMISSION_MODE ? AGENT_SUPPORTS_PLAN_MODE[to]
    : mode === ASK_PERMISSION_MODE ? AGENT_SUPPORTS_ASK_MODE[to]
    : AGENT_SUPPORTS_PERMISSION_MODES[to] && PERMISSION_MODES.some((m) => m.id === mode);
  return keeps ? mode : fallback;
}

export type HandoffNotesGenerator = (input: HandoffNotesInput) => Promise<string>;

/**
 * The hand-off note a switch writes: what the incoming agent is handed, and a file the person can
 * open from the transcript's line.
 *
 * Its judgement — the ask, the decisions, what changed and where, what is open, where things stand —
 * is written on the frontier model (`generateHandoffNotes`). Its facts are Realm's own and never the
 * model's: the files edited, counted off the log, and the last turns quoted as they were written.
 *
 * When that call cannot be made (no generator in a harness, no Claude on the machine) or fails, the
 * note carries the conversation verbatim instead, capped as a failover handoff's is. Never a cheaper
 * model: an account of the work the next agent acts on is the last place to save on one.
 */
export class HandoffNotes {
  constructor(private d: {
    home: string;
    events: SessionEventsStore;
    /** Omitted on any build that must not make a billed call — tests, live checks. */
    generate?: HandoffNotesGenerator;
    /** Whether the machine can run one, asked before the call so a Mac with no Claude CLI pays nothing. */
    available?: () => boolean | Promise<boolean>;
    onError?: (line: string) => void;
    now?: () => number;
  }) {}

  /** Write the note for a switch from `from` to `to` (models by name) and say where it is. */
  async write(session: Session, sides: { from: string; to: string }): Promise<{ path: string; notes: string }> {
    const now = this.d.now?.() ?? Date.now();
    const events = this.d.events.listAfter(session.id, 0, 20_000);
    const facts = sessionFacts(events.map((e) => e.event));
    const turns = this.d.events.transcript(session.id, now);
    const written = await this.summarize({
      title: session.title, asked: facts.asked, transcript: transcriptForSummary(events), facts: factLines(facts), ...sides,
    });
    const files = facts.edited.map((p) => `- \`${inside(session.cwd, p)}\``);
    const head = `Switched from ${sides.from} to ${sides.to} on ${stamp(now)}, in \`${session.cwd}\`.`;
    let sections: string[];
    if (written) {
      const last = carriedTranscript(turns.slice(lastIndexOfNth(turns, "user", LAST_TURNS) ?? 0), LAST_TURNS_MAX);
      sections = [
        head, written,
        ...(files.length > 0 ? [`## Files edited\n\n${files.join("\n")}`] : []),
        ...(turns.length > 0 ? [`## Last turns\n\n${last.fence}text\n${last.body}\n${last.fence}`] : []),
      ];
    } else {
      const all = carriedTranscript(turns, HANDOFF_CONTEXT_MAX);
      sections = [
        `${head} No summary was written, so the conversation is carried as written${all.truncated ? `, from its newest ${HANDOFF_CONTEXT_MAX.toLocaleString("en-US")} characters` : ""}.`,
        ...(files.length > 0 ? [`## Files edited\n\n${files.join("\n")}`] : []),
        ...(turns.length > 0 ? [`## Conversation\n\n${all.fence}text\n${all.body}\n${all.fence}`] : []),
      ];
    }
    const notes = [`# ${session.title}`, ...sections].join("\n\n") + "\n";
    const dir = join(handoffsRoot(this.d.home), session.id);
    await mkdir(dir, { recursive: true });
    const n = (await readdir(dir)).filter((f) => /^\d+\.md$/.test(f)).length + 1;
    const path = join(dir, `${n}.md`);
    await writeFile(path, notes);
    return { path, notes };
  }

  /** A deleted session's notes go with it: they describe a conversation nobody can open any more. */
  async release(sessionId: string): Promise<void> {
    await rm(join(handoffsRoot(this.d.home), sessionId), { recursive: true, force: true });
  }

  private async summarize(input: HandoffNotesInput): Promise<string | null> {
    if (!this.d.generate) return null;
    if (this.d.available) {
      let ok = false;
      try { ok = await this.d.available(); } catch { ok = false; }
      if (!ok) return null;
    }
    try {
      return await this.d.generate(input);
    } catch (e) {
      this.d.onError?.(`[handoff] ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
}

/** Where the `n`th-from-last turn of `role` starts, or null when there are fewer than `n`. */
function lastIndexOfNth(turns: readonly { role: string }[], role: string, n: number): number | null {
  let seen = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === role && ++seen === n) return i;
  }
  return null;
}

/** A path as the checkout names it, where it is in the checkout. */
function inside(cwd: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const r = relative(cwd, path);
  return r && !r.startsWith("..") && !isAbsolute(r) ? r : path;
}

/** `2026-11-02 14:03`, in the Mac's own time. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
