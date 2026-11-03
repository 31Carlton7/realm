import { homedir } from "node:os";
import {
  AGENT_SESSION_RESUME, HANDOFF_CONTEXT_MAX, buildMoveContext, carriedTranscript, fenceFor, handoffContextKey, sessionEvent,
  type AgentKind, type Environment, type MoveConversation, type MovePlace, type MoveStep, type MoveTarget, type Session,
  type SessionEvent, type SessionEventPayload,
} from "@realm/contracts";
import type { SessionsStore, SessionEventsStore } from "../store/sessions";
import type { SettingsStore } from "../store/settings";
import type { Db } from "../db/database";
import { RpcError } from "../store/rows";
import type { CapturedState, CheckpointGit } from "../workspace/checkpoints";
import { undoRehome, type Rehomed } from "../accounts/service";

/** The one-time word to the agent on its first turn after a move, until that turn spends it. */
export const movePrefaceKey = (sessionId: string): string => `move.preface:${sessionId}`;
/** A Claude move's notes, carried in case the CLI does not find the record it was re-homed, until a
 *  resume is accepted: `before` is the hand-off context they took the place of. */
export const moveFallbackKey = (sessionId: string): string => `move.fallback:${sessionId}`;
/** A move under way (`MoveInFlight`), so a server that stops mid-move can take it back when it comes up. */
export const moveInFlightKey = (sessionId: string): string => `move.inFlight:${sessionId}`;

/** What a move under way has changed so far, kept as it goes. Each fact is written before the change
 *  it undoes, so a restart finds every change the move made. */
export type MoveInFlight = {
  moveId: string;
  sourcePath: string;
  /** The checkout the changes were merged into, its checkpoint from before, and `after`, the same
   *  checkpoint with the merge's working tree: what the checkout is until someone works in it. */
  merged?: Merged;
  /** The worktree made for the move. */
  worktreeId?: string;
  rehomed?: Rehomed;
};

type Merged = { path: string; environmentId: string; state: CapturedState; after: CapturedState };

export type MoveDeps = {
  db: Db;
  sessions: SessionsStore;
  events: SessionEventsStore;
  settings: SettingsStore;
  git: CheckpointGit;
  /** The session's environment as a row; null when it is gone. */
  environment: (id: string) => Environment | null;
  /** Whether a session other than `sessionId` is mid-turn in that checkout. Asked again just before
   *  a checkout is written, since a turn can start there while the move is under way. */
  othersWorkingIn: (environmentId: string, sessionId: string) => boolean;
  /** The checkpoint taken before anything moves: the undo point for the source tree. */
  capture: (input: { environmentId: string; sessionId: string | null; label: string }) => Promise<{ state: CapturedState } | null>;
  createWorktree: (input: { spaceId: string; title: string | null; from: string; base: string | null }) => Promise<Environment>;
  /** Take back a worktree this move made, directory, branch and row. */
  discardWorktree: (env: Environment, sourcePath: string) => Promise<void>;
  /** Make the provider's record findable from the new cwd; what it changed, or null where it cannot. */
  rehome?: (kind: AgentKind, providerSessionId: string, accountId: string | null, cwd: { from: string; to: string }) => Promise<Rehomed | null>;
  handoffNotes?: { write(session: Session, sides: { from: string; to: string }, how: "moved"): Promise<{ path: string; notes: string }> };
  /** Stop the engine the way the idle sweep does. */
  stop: (sessionId: string) => Promise<void>;
  /** What the engine is running beyond a turn — background tasks, scheduled jobs — which stopping it
   *  stops too. */
  engineWork: (sessionId: string) => Promise<string[]>;
  /** Start the engine at `env` with a resume, send nothing, and answer its `init`. */
  boot: (sessionId: string, env: Environment) => Promise<SessionEventPayload<"init">>;
  /** Put an event on the transcript, down the path the pump uses. */
  emit: (sessionId: string, ev: SessionEvent) => void;
  broadcastStatus: (sessionId: string, status: Session["status"]) => void;
  /** Close the session's terminal, answering whether it had one. Its pty was spawned at the old cwd. */
  closeTerminal: (sessionId: string) => boolean;
  home?: string;
};

/** `stopping`: the person asked to stop what the agent is doing and move, background work included. */
export type MovePlan = { moveId: string; to: MoveTarget; keepSourceChanges: boolean; stopping: boolean; signal: AbortSignal };

/**
 * Move a started session to another checkout on this machine, mid-conversation: freeze, snapshot,
 * place, boot, commit — and on any failure before the commit, put everything back.
 *
 * The order is `handOver`'s, for its reason: the engine is stopped before anything is rewritten, and
 * the carried context is written with the row, so a start never sees one without the other. The row
 * is rewritten only at the commit, in one transaction: until then the session is where it was, and a
 * server that stops mid-move comes back with it there, and with what the move had changed taken back
 * (`undoInterruptedMove`).
 *
 * Answers how the conversation travelled. Every failure writes `move_failed` and rejects with
 * MOVE_FAILED.
 */
export async function runMove(d: MoveDeps, s: Session, plan: MovePlan): Promise<MoveConversation> {
  const undo: (() => Promise<void> | void)[] = [];
  /** What a rollback left as it was, said in `move_failed`. */
  const leftAsItWas: string[] = [];
  let step: MoveStep = "preflight";
  const at = (next: MoveStep) => {
    if (plan.signal.aborted) throw new RpcError("MOVE_CANCELLED", "the move was cancelled");
    step = next;
    d.emit(s.id, sessionEvent("moving", { moveId: plan.moveId, step }));
  };
  const source = d.environment(s.environmentId);
  try {
    at("preflight");
    if (!source) throw new RpcError("MOVE_FAILED", "the checkout it runs in is gone");
    const isRepo = await d.git.isRepository(source.path);
    if (plan.to.kind === "worktree" && !isRepo) throw new RpcError("MOVE_FAILED", `${source.path} is not a git repository, so it has no worktrees`);
    const existing = plan.to.kind === "environment" ? d.environment(plan.to.environmentId) : null;
    if (plan.to.kind === "environment" && !existing) throw new RpcError("MOVE_FAILED", "that checkout is gone");
    const work = await d.engineWork(s.id);
    if (work.length > 0 && !plan.stopping) throw new RpcError("MOVE_FAILED", `its agent is still running ${work.join(", ")}, which moving would stop`);

    at("freeze");
    const inFlight: MoveInFlight = { moveId: plan.moveId, sourcePath: source.path };
    const keep = (facts: Partial<MoveInFlight>) => d.settings.set(moveInFlightKey(s.id), Object.assign(inFlight, facts));
    keep({});
    undo.push(() => d.settings.set(moveInFlightKey(s.id), null));
    d.sessions.update({ id: s.id, status: "moving" });
    d.broadcastStatus(s.id, "moving");
    undo.push(() => { d.sessions.update({ id: s.id, status: "idle" }); d.broadcastStatus(s.id, "idle"); });
    await d.stop(s.id);

    at("snapshot");
    const label = existing ? existing.path : "a new worktree";
    const cp = isRepo ? await d.capture({ environmentId: source.id, sessionId: s.id, label: `Before move to ${label}` }) : null;
    if (isRepo && !cp) throw new RpcError("MOVE_FAILED", "the checkpoint before the move could not be taken");
    const changedFiles = cp ? await d.git.changedFiles({ cwd: source.path, state: cp.state }) : 0;
    const secrets = isRepo ? await d.git.secretLookingIgnored(source.path) : [];

    at("place");
    let target: Environment;
    if (plan.to.kind === "worktree") {
      const base = plan.to.base ?? null;
      target = await d.createWorktree({ spaceId: s.spaceId, title: s.title, from: plan.to.from ?? source.id, base: base ?? cp!.state.headSha });
      const made = target;
      keep({ worktreeId: made.id });
      undo.push(() => d.discardWorktree(made, source.path));
      // At the session's own HEAD the checkpoint goes in exactly, staged files staged; on any other
      // base only its changes can, merged onto it.
      if (changedFiles > 0 && base === null) await d.git.extract({ cwd: target.path, state: cp!.state });
      else if (changedFiles > 0) await d.git.applyChanges({ cwd: target.path, state: cp!.state, into: null });
    } else {
      target = existing!;
      if (changedFiles > 0) {
        const merged = await mergeInto(d, s, target, cp!.state, keep);
        undo.push(async () => {
          const left = await takeBackMerge(d, merged, s.id, d.home ?? homedir());
          if (left) leftAsItWas.push(left);
        });
      }
    }

    const carried = await carryConversation(d, s, source, target, at, undo, keep);

    at("commit");
    const [from, to] = await Promise.all([placeOf(d.git, source), placeOf(d.git, target)]);
    const hadTerminal = d.closeTerminal(s.id);
    d.db.exec("BEGIN");
    try {
      d.sessions.setEnvironment(s.id, target.id);
      d.sessions.update({ id: s.id, status: "idle", providerSessionId: carried.providerSessionId });
      if (carried.fallback) d.settings.set(moveFallbackKey(s.id), { before: d.settings.get(handoffContextKey(s.id)) });
      if (carried.context !== null) d.settings.set(handoffContextKey(s.id), carried.context);
      d.settings.set(moveInFlightKey(s.id), null);
      d.db.exec("COMMIT");
    } catch (e) { d.db.exec("ROLLBACK"); throw e; }
    d.broadcastStatus(s.id, "idle");
    // After the commit and never before it: until the move has happened, the source keeps its changes.
    const kept = !plan.keepSourceChanges && cp ? await clearSource(d, s, source, cp.state) : [];
    const leftBehind = [...(hadTerminal ? ["the terminal"] : []), ...secrets, ...work.map((w) => `${w} (stopped)`), ...kept];
    const preface = movePreface(from, to, leftBehind);
    d.settings.set(movePrefaceKey(s.id), preface);
    d.emit(s.id, sessionEvent("moved", {
      moveId: plan.moveId, from, to, conversation: carried.conversation, changedFiles, leftBehind, preface,
      note: movedNote(from, to, carried.conversation, d.home ?? homedir()),
    }));
    return carried.conversation;
  } catch (e) {
    for (const u of undo.reverse()) { try { await u(); } catch { /* the failure being reported is the one that matters */ } }
    const reason = e instanceof Error ? e.message : String(e);
    const where = source ? tilde(source.path, d.home ?? homedir()) : "its checkout";
    const note = [`Could not move this session: ${reason}. It is still in ${where}, as it was.`, ...leftAsItWas].join(" ");
    d.emit(s.id, sessionEvent("move_failed", { moveId: plan.moveId, step, reason, note }));
    throw new RpcError("MOVE_FAILED", note);
  }
}

/** Merge the session's changes into a checkout that has its own state, after a checkpoint of that
 *  state — the undo, kept and answered. */
async function mergeInto(d: MoveDeps, s: Session, into: Environment, state: CapturedState,
  keep: (facts: Partial<MoveInFlight>) => void): Promise<Merged> {
  const before = await d.capture({ environmentId: into.id, sessionId: null, label: `Before “${s.title}” moved in` });
  if (!before) throw new RpcError("MOVE_FAILED", `${into.path} is not a git repository, so the changes cannot go into it`);
  if (d.othersWorkingIn(into.id, s.id)) throw new RpcError("MOVE_FAILED", "another session started working in that checkout");
  const tree = await d.git.mergedTree({ cwd: into.path, state, into: before.state });
  const merged = { path: into.path, environmentId: into.id, state: before.state, after: { ...before.state, worktreeTree: tree } };
  keep({ merged });
  await d.git.applyChanges({ cwd: into.path, state, into: before.state });
  return merged;
}

/** Put a checkout the changes were merged into back as it was — `clearSource`'s rule: only while it is
 *  still as the merge left it and no other session is working there, since a restore would throw away
 *  anything done there since. Answers the sentence saying it was left, or null. */
async function takeBackMerge(d: Pick<MoveDeps, "git" | "othersWorkingIn">, merged: Merged, sessionId: string, home: string): Promise<string | null> {
  const left = (why: string) => `The changes it merged into ${tilde(merged.path, home)} are still there, since ${why}.`;
  if (d.othersWorkingIn(merged.environmentId, sessionId)) return left("another session is working there");
  const since = await d.git.hazard({ cwd: merged.path, state: merged.after }).catch(() => null);
  if (!since || since.filesChanged > 0 || since.commitsRolledBack > 0) return left("that checkout changed after they went in");
  await d.git.restore({ cwd: merged.path, state: merged.state });
  return null;
}

/** Put the source back to its HEAD once the changes are in the new checkout — unless they changed
 *  since the checkpoint, or another session is working there now, either of which a reset would
 *  throw away. Answers what it kept, to name as left behind. */
async function clearSource(d: MoveDeps, s: Session, source: Environment, state: CapturedState): Promise<string[]> {
  const since = await d.git.hazard({ cwd: source.path, state });
  if (since.filesChanged > 0 || since.commitsRolledBack > 0) return ["its uncommitted changes (they changed during the move)"];
  if (d.othersWorkingIn(source.id, s.id)) return ["its uncommitted changes (another session is working there)"];
  await d.git.resetToHead(source.path).catch(() => {});
  return [];
}

/**
 * Take the conversation to the new cwd, natively where the agent can resume its own record of it
 * there, and as a hand-off note where it cannot. A refused resume is not a failure of the move: the
 * agent starts fresh there, handed the note. Answers the context to carry, which the commit writes —
 * for Claude, whose resume is only known to work when the CLI next starts, a note to fall back on.
 */
async function carryConversation(d: MoveDeps, s: Session, source: Environment, target: Environment,
  at: (step: MoveStep) => void, undo: (() => Promise<void> | void)[], keep: (facts: Partial<MoveInFlight>) => void,
): Promise<{ conversation: MoveConversation; providerSessionId: string | null; context: string | null; fallback?: boolean }> {
  const mode = AGENT_SESSION_RESUME[s.agentKind].mode;
  const id = s.providerSessionId;
  if (id !== null && s.agentKind === "claude") {
    const rehomed = await d.rehome?.(s.agentKind, id, s.accountId ?? null, { from: source.path, to: target.path });
    if (rehomed) {
      keep({ rehomed });
      undo.push(() => undoRehome(rehomed));
      const notes = carriedTranscript(d.events.transcript(s.id, Date.now()), HANDOFF_CONTEXT_MAX).body;
      return { conversation: "native", providerSessionId: id, context: claudeFallbackContext(notes, source.path, target.path), fallback: true };
    }
  } else if (id !== null && mode !== "none") {
    at("boot");
    undo.push(() => d.stop(s.id));
    const init = await d.boot(s.id, target);
    if (init.resumeOutcome !== "declined" && init.resumeOutcome !== "unsupported") {
      return { conversation: "native", providerSessionId: init.providerSessionId, context: null };
    }
    await d.stop(s.id);
  }
  const written = await d.handoffNotes?.write(s, { from: source.path, to: target.path }, "moved").catch(() => null) ?? null;
  const notes = written?.notes ?? carriedTranscript(d.events.transcript(s.id, Date.now()), HANDOFF_CONTEXT_MAX).body;
  const context = buildMoveContext({ agent: s.agentKind, notes, ...(written ? { path: written.path } : {}), from: source.path, to: target.path });
  return { conversation: "notes", providerSessionId: null, context };
}

/** Take back what a move the server stopped in the middle had changed, newest first. Best effort:
 *  each step is tried whatever the one before it did. Answers what it left as it was, to say so. */
export async function undoInterruptedMove(d: Pick<MoveDeps, "git" | "environment" | "discardWorktree" | "othersWorkingIn" | "home">,
  sessionId: string, kept: MoveInFlight): Promise<string[]> {
  const left: string[] = [];
  if (kept.rehomed) await undoRehome(kept.rehomed).catch(() => {});
  if (kept.merged) {
    const merged = await takeBackMerge(d, kept.merged, sessionId, d.home ?? homedir()).catch(() => null);
    if (merged) left.push(merged);
  }
  const made = kept.worktreeId ? d.environment(kept.worktreeId) : null;
  if (made) await d.discardWorktree(made, kept.sourcePath).catch(() => {});
  return left;
}

function claudeFallbackContext(notes: string, from: string, to: string): string {
  const fence = fenceFor(notes);
  return [
    "# Moved mid-session",
    `This session was moved from ${from} to ${to}. If the conversation before this message is there, carry on with it and ignore this note. ` +
    "If it is not, it did not move with you, and Realm's record of it is below.",
    `Paths in it are under ${from}; the same work, uncommitted changes included, is now under ${to} — work there.`,
    `${fence}markdown\n${notes}\n${fence}`,
  ].join("\n\n");
}

/** Only a worktree's row keeps its branch; any other checkout is on whatever branch git has out now. */
export async function placeOf(git: Pick<CheckpointGit, "branch"> | undefined, env: Environment): Promise<MovePlace> {
  const branch = env.branch ?? (git ? await git.branch(env.path) : null);
  return { machine: null, environmentId: env.id, cwd: env.path, branch };
}

/** What the agent is told on its first turn after the move. It names both roots because every path in
 *  the conversation so far is under the old one. */
export function movePreface(from: MovePlace, to: MovePlace, leftBehind: readonly string[]): string {
  const where = (p: MovePlace) => `${p.cwd}${p.branch ? ` (branch ${p.branch})` : ""}`;
  return [
    `Realm moved this session before this message. It ran in ${where(from)} and now runs in ${where(to)}, on the same machine.`,
    `Paths in the conversation so far are under ${from.cwd}; the same work, uncommitted changes included, is now under ${to.cwd}. Use the new paths from here on.`,
    ...(leftBehind.length > 0 ? [`Left behind in the old checkout: ${leftBehind.join(", ")}.`] : []),
  ].join(" ");
}

function movedNote(from: MovePlace, to: MovePlace, conversation: MoveConversation, home: string): string {
  const how = conversation === "native" ? "The conversation continued." : "The conversation was carried as notes.";
  return `Moved from ${tilde(from.cwd, home)} to ${tilde(to.cwd, home)}. ${how}`;
}

const tilde = (path: string, home: string): string => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
