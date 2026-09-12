import { existsSync } from "node:fs";
import {
  AGENT_CONVERSATION_REWIND, newId,
  type Checkpoint, type CheckpointKind, type RestoreAck, type RestorePreview, type RestoreResult,
} from "@realm/contracts";
import type { CheckpointsStore } from "../store/checkpoints";
import type { EnvironmentsStore } from "../store/environments";
import type { SessionsStore } from "../store/sessions";
import { NotFoundError, RpcError } from "../store/rows";
import { CheckpointGit, checkpointRef } from "../workspace/checkpoints";
import { decodeProviderCursor, decodeSessionCursor, encodeArmedRewind, encodeProviderCursor, encodeSessionCursor } from "./rewind";

/**
 * Retention: the newest `MAX_CHECKPOINTS_PER_ENVIRONMENT` per environment, oldest dropped first.
 *
 * Count, not age. Age was considered and rejected: what a bound is protecting against here is disk,
 * and disk is what a count bounds directly — while an age rule would silently delete the undo of a
 * restore you did three weeks ago, which is the one checkpoint whose value goes UP with time. Two
 * checkpoints are exempt from the count as well (`CheckpointsStore.prunable`): the newest overall, and
 * the newest `pre-restore`.
 *
 * 50 is chosen against what a checkpoint actually costs. Each one stores only the blobs that changed
 * since the last, because git deduplicates by content — a turn that edits three files adds three
 * blobs, and a turn that edits nothing adds two commit objects and nothing else. Fifty turns of a
 * normal session is well under a megabyte, and the pathological case (an agent rewriting a large
 * generated file every turn) is bounded at fifty copies rather than at infinity.
 *
 * Pruning deletes the ref AND the row, in that order, so the objects are unreferenced the moment the
 * row goes. They are then collected by the repository's own `git gc` — after `gc.pruneExpire`, two
 * weeks by default. Realm never runs `gc` in a user's repository: an unasked-for repack in the middle
 * of a turn is worse than two weeks of loose objects.
 */
export const MAX_CHECKPOINTS_PER_ENVIRONMENT = 50;

/** One line, clipped — a label is a glance, not a transcript. */
export const LABEL_MAX = 72;
export function labelFrom(text: string): string {
  const line = text.trim().split("\n").find((l) => l.trim()) ?? "";
  const one = line.replace(/\s+/g, " ").trim();
  if (one === "") return "Untitled turn";
  return one.length > LABEL_MAX ? `${one.slice(0, LABEL_MAX - 1).trimEnd()}…` : one;
}

export type CheckpointDeps = {
  checkpoints: CheckpointsStore;
  environments: EnvironmentsStore;
  sessions: SessionsStore;
  git: CheckpointGit;
  /** Whether a live adapter handle is attached to any session in this environment. Injected rather than
   *  imported: `SessionService` calls INTO this service on every turn, so it cannot also be a dependency. */
  isEnvironmentBusy?: (environmentId: string) => boolean;
  /** Retention budget per environment. Overridable only so tests can reach the pruning branch without
   *  spawning fifty-odd git processes; production passes nothing. */
  maxPerEnvironment?: number;
  /** Plan 12 W5: the feed's worktree_hazard hook, called when a restore is REFUSED on a stale
   *  acknowledgement (the tree moved under an open confirmation). Optional — a harness without the
   *  notifications feed behaves exactly as before. */
  notifications?: { worktreeHazard(input: { spaceId: string | null; environmentId: string; title: string; body: string }): void };
  /**
   * Rewind ONE session's conversation to where this checkpoint found it: truncate Realm's stored
   * transcript to `throughSeq`, and arm `fork` so the session's next adapter start resumes the provider
   * conversation at that point. Returns whether it actually happened.
   *
   * Injected rather than imported, for the same knot `isEnvironmentBusy` documents: `SessionService`
   * calls INTO this service on every turn, so it cannot also be a dependency of it. It is also the
   * right owner — it holds the live handles, the event store and the broadcast channel, none of which
   * belong to checkpoints.
   *
   * Optional, and its absence is reported rather than hidden: a harness wired without it answers
   * `rewindsConversation: false` everywhere, which is the truth for that harness.
   */
  rewindSession?: (input: { sessionId: string; throughSeq: number; fork: string }) => boolean;
};

/**
 * Checkpoints (Plan 7 W4): one captured workspace state per agent turn, and a restore that cannot
 * lose work.
 *
 * The three rules this class exists to hold:
 *
 *  1. **A row and its ref live and die together.** A row whose ref is gone is a restore that finds
 *     nothing; a ref whose row is gone is objects pinned forever with nothing pointing at them — the
 *     slow disk leak. Every write here does both, refs first on the way out.
 *  2. **Restore captures what it is about to destroy, first.** Not as a courtesy: it is the reason
 *     restoring is offered at all. `RestoreResult.undoCheckpointId` names that capture, and if the
 *     capture fails the restore does not happen.
 *  3. **A checkpoint only ever reaches the environment it was taken in.** The row carries the
 *     environment id; the path is read from that row's environment and from nothing the caller said.
 */
export class CheckpointService {
  constructor(private d: CheckpointDeps) {}

  /**
   * The `turn` checkpoint each session's IN-FLIGHT turn was captured in front of.
   *
   * In memory, and the one thing lost with it is a cursor. A checkpoint's provider cursor needs two
   * uuids known at two different moments — the kept turn's last chain entry (at capture) and the
   * discarded turn's prompt (once the turn has run) — so the row is completed at the settle, and this
   * map is how the settle finds the row. A crash between the two leaves the checkpoint with no cursor,
   * which restores the files and says so: exactly what Realm knows about that turn and nothing more.
   */
  private turnCheckpoints = new Map<string, string>();

  list(environmentId: string, sessionId: string | null): Checkpoint[] {
    this.environment(environmentId);
    return this.d.checkpoints.list(environmentId, sessionId);
  }

  private environment(id: string) {
    const env = this.d.environments.get(id); if (!env) throw new NotFoundError("environment", id);
    return env;
  }

  /**
   * Capture the environment's current state.
   *
   * Returns null — rather than throwing — when there is nothing to checkpoint: the directory is gone,
   * or it is not a git repository. A plain folder is an ordinary Realm space, and a session in one must
   * still be able to send a message.
   */
  async capture(input: { environmentId: string; sessionId: string | null; kind: CheckpointKind; label: string }): Promise<Checkpoint | null> {
    const env = this.environment(input.environmentId);
    if (!existsSync(env.path) || !await this.d.git.isRepository(env.path)) return null;

    const id = newId();
    const ref = checkpointRef(env.id, id);
    const state = await this.d.git.capture({ cwd: env.path, environmentId: env.id, checkpointId: id, message: `realm: ${input.label}` });
    // Realm's own transcript position, read AFTER the git work rather than before it: `capture` is
    // awaited in front of the message, so nothing of this turn is on the rail yet either way, and
    // reading it last means the number is as close to the restore point as this method can make it.
    // Null outside a session, which is the honest answer and not a zero — a zero would claim the
    // transcript was empty.
    const sessionSeq = input.sessionId ? this.d.sessions.get(input.sessionId)?.lastEventSeq ?? null : null;
    let checkpoint: Checkpoint;
    try {
      checkpoint = this.d.checkpoints.create({ id, environmentId: env.id, sessionId: input.sessionId, kind: input.kind, label: input.label, ref, state, sessionSeq });
    } catch (e) {
      // The ref exists and the row does not: exactly the leak rule 1 forbids. Take the ref back off.
      await this.d.git.deleteRefs(env.path, [ref]).catch(() => {});
      throw e;
    }
    await this.prune(env.id, env.path);
    return checkpoint;
  }

  /**
   * The per-turn capture, taken in front of the agent — the state as it was BEFORE the message.
   *
   * Awaited, not fired and forgotten: a capture racing the agent's first write records a tree that
   * never existed. But it can never fail the turn, so every error is swallowed and logged. The bound on
   * how long it can delay a message is `gitCapture`'s own 20s timeout.
   */
  async captureTurn(sessionId: string, text: string, onLog?: (line: string) => void): Promise<Checkpoint | null> {
    const session = this.d.sessions.get(sessionId);
    if (!session) return null;
    try {
      const checkpoint = await this.capture({ environmentId: session.environmentId, sessionId, kind: "turn", label: labelFrom(text) });
      // Claimed even when the capture declined (a plain folder): the map is keyed by session, and a
      // stale entry from three turns ago would attach THIS turn's prompt uuid to the wrong checkpoint.
      if (checkpoint) this.turnCheckpoints.set(sessionId, checkpoint.id); else this.turnCheckpoints.delete(sessionId);
      return checkpoint;
    } catch (e) {
      this.turnCheckpoints.delete(sessionId);
      onLog?.(`[checkpoints] capture failed for session ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * A turn settled: write down where the provider's conversation now stands, and complete the cursor on
   * the checkpoint this turn was captured in front of.
   *
   * Two writes, and they are the two halves of one fact:
   *
   *  - the checkpoint that FRONTED this turn gets `{session, at: <where the previous turn ended>,
   *    dropsTurn: <this turn's prompt>}` — everything `resumeSessionAt` + `resumeDropsTurn` need to put
   *    the model back on the far side of this turn;
   *  - the session row's cursor moves to where THIS turn ended, which is what the NEXT turn's
   *    checkpoint will fork to.
   *
   * `session` is the guard that keeps the two uuids in one chain. The pair is written only when the
   * previous turn's cursor was recorded under the same provider session id this turn ran in: the SDK
   * forks to a new session id on every resume, so a pair spanning a restart would name a position in a
   * chain the resumed session may not have. A mismatch writes no cursor at all, and that checkpoint
   * restores the files only.
   *
   * Only `turn` checkpoints ever get a cursor, because only a turn checkpoint fronts exactly ONE turn —
   * which is precisely the unit `resumeDropsTurn` validates. A `manual` or `pre-restore` checkpoint
   * fronts no turn, so there is nothing it could honestly declare as dropped.
   */
  noteTurnCursor(sessionId: string, turn: { providerSessionId: string | null; promptUuid: string | null; endUuid: string | null }): void {
    const checkpointId = this.turnCheckpoints.get(sessionId) ?? null;
    this.turnCheckpoints.delete(sessionId);
    const session = this.d.sessions.get(sessionId);
    if (!session || !AGENT_CONVERSATION_REWIND[session.agentKind]) return;
    if (!turn.providerSessionId) return; // nothing to name a chain by; nothing worth writing down
    const previous = decodeSessionCursor(this.d.sessions.providerCursor(sessionId));
    if (checkpointId && turn.promptUuid && previous?.session === turn.providerSessionId) {
      this.d.checkpoints.setProviderCursor(checkpointId,
        encodeProviderCursor({ session: turn.providerSessionId, at: previous.at, dropsTurn: turn.promptUuid }));
    }
    if (turn.endUuid) {
      this.d.sessions.setProviderCursor(sessionId, encodeSessionCursor({ session: turn.providerSessionId, at: turn.endUuid }));
    }
  }

  /**
   * A provider refused the fork this checkpoint's cursor described.
   *
   * The cursor goes, permanently. The refusal is deterministic — the same request fails forever — so a
   * row that went on advertising it would be an invitation to re-send something that can only fail
   * again, and `rewindsConversation` would keep promising a rewind this checkpoint cannot deliver.
   * What is kept is the provider's own account of why, which `SessionService` writes onto the session
   * and onto its transcript.
   */
  forgetProviderCursor(checkpointId: string): void {
    this.d.checkpoints.setProviderCursor(checkpointId, null);
  }

  /** What restoring would cost, and whether the checkpoint is still usable at all. */
  async preview(id: string): Promise<RestorePreview> {
    const cp = this.d.checkpoints.require(id);
    const env = this.environment(cp.environmentId);
    const base = {
      checkpointId: cp.id, environmentId: env.id, path: env.path, label: cp.label, createdAt: cp.createdAt,
      rewindsConversation: this.rewindsConversation(cp),
    };
    if (!existsSync(env.path) || !await this.d.git.isRepository(env.path) || !await this.d.git.refIntact(env.path, cp.ref, cp.commitSha)) {
      return { ...base, filesChanged: 0, commitsRolledBack: 0, headMovable: false, headReason: null, intact: false };
    }
    const h = await this.d.git.hazard({ cwd: env.path, state: cp.state });
    return { ...base, filesChanged: h.filesChanged, commitsRolledBack: h.commitsRolledBack, headMovable: h.headMovable, headReason: h.headReason, intact: true };
  }

  /**
   * Put the checkout back the way this checkpoint found it.
   *
   * Order, and why each step is where it is:
   *
   *  1. Refuse while an agent is live in that environment. Rewriting a working tree under a running
   *     tool call corrupts whatever it is halfway through, and no checkpoint can undo a half-written file.
   *  2. Re-read the hazard and require the acknowledgement to match it exactly. The user said yes to
   *     numbers; if the agent has written another file since, those numbers are not the ones they saw.
   *  3. Capture the CURRENT state as a `pre-restore` checkpoint. If this fails, nothing is restored —
   *     the whole safety argument for offering restore is that it is itself undoable.
   *  4. Restore.
   *  5. LAST, and only if step 4 succeeded: rewind the conversation to match.
   *
   * Step 5's position is the whole of its correctness. A transcript truncated before the workspace
   * restore, on a restore that then failed, is not a partial success — it is destruction: the turns
   * that wrote the files are gone from Realm's record while the files themselves are still there, and
   * no checkpoint undoes that (a `pre-restore` checkpoint holds a TREE, not a transcript). Files first
   * means the worst case is the opposite order of damage, which is not damage at all: the workspace is
   * back, the agent still remembers, and the result says `conversationRewound: false`.
   */
  async restore(id: string, acknowledge: RestoreAck): Promise<RestoreResult> {
    const cp = this.d.checkpoints.require(id);
    const env = this.environment(cp.environmentId);

    if (this.d.isEnvironmentBusy?.(env.id)) {
      throw new RpcError("CHECKPOINT_ENVIRONMENT_BUSY", "an agent is still running in this checkout; stop it before restoring");
    }
    const preview = await this.preview(id);
    if (!preview.intact) {
      throw new RpcError("CHECKPOINT_GONE", "this checkpoint's git objects are no longer in the repository");
    }
    if (acknowledge.filesChanged !== preview.filesChanged || acknowledge.commitsRolledBack !== preview.commitsRolledBack) {
      // The user said yes to numbers the checkout has since moved past — a hazard worth a feed row,
      // because the sheet they were looking at is exactly the surface that just went stale under them.
      this.d.notifications?.worktreeHazard({ spaceId: env.spaceId, environmentId: env.id,
        title: "Checkpoint restore refused", body: describeRestore(preview) });
      throw new RpcError("RESTORE_UNSAFE", describeRestore(preview));
    }

    // Rule 2. `capture` throws on a git failure and returns null only when there is nothing to capture,
    // which cannot happen here — `preview.intact` already established this is a live repository.
    const undo = await this.capture({ environmentId: env.id, sessionId: cp.sessionId, kind: "pre-restore", label: `Before restoring “${cp.label}”` });

    const outcome = await this.d.git.restore({ cwd: env.path, state: cp.state });
    return {
      environmentId: env.id, path: env.path,
      undoCheckpointId: undo?.id ?? null,
      headMoved: outcome.headMoved,
      filesChanged: preview.filesChanged,
      commitsRolledBack: outcome.headMoved ? preview.commitsRolledBack : 0,
      filesRemoved: outcome.filesRemoved,
      // Per session and per checkpoint, never a constant — and re-derived rather than read off
      // `preview`, because `preview` was taken before the files moved and this is a report of what
      // actually happened.
      conversationRewound: this.rewind(cp),
    };
  }

  /**
   * The conversation half of a restore: Realm's transcript back to `sessionSeq`, and the provider's
   * next start armed to resume at `providerCursor`.
   *
   * Both or neither, which is why there is one method and one return value. Truncating Realm's own
   * transcript without rewinding the provider is the lie `AGENT_CONVERSATION_REWIND` was written to
   * forbid — the turns would leave the reader's screen and stay in the model's context.
   *
   * Failure here is reported, never thrown. The files are already back by the time this runs, and a
   * restore that put the workspace right must not be reported to the caller as a failure because the
   * conversation could not follow.
   */
  private rewind(cp: Checkpoint): boolean {
    if (!this.rewindsConversation(cp)) return false;
    const cursor = decodeProviderCursor(cp.providerCursor)!;
    try {
      return this.d.rewindSession!({
        sessionId: cp.sessionId!, throughSeq: cp.sessionSeq!,
        fork: encodeArmedRewind({ ...cursor, checkpointId: cp.id }),
      });
    } catch {
      return false;
    }
  }

  /**
   * Drop every checkpoint this environment owns, refs first.
   *
   * Called before an environment row goes away. The refs come from BOTH the rows and `for-each-ref`,
   * because they are the two ways to know and either can be the incomplete one: a row lost to a failed
   * write still left a ref behind, and that ref pins its objects in the main repository for good.
   */
  async forgetEnvironment(environmentId: string): Promise<void> {
    const env = this.d.environments.get(environmentId);
    const rows = this.d.checkpoints.list(environmentId);
    const path = env?.path;
    if (path && existsSync(path)) {
      const refs = new Set([...this.d.checkpoints.refs(environmentId), ...await this.d.git.listRefs(path, environmentId)]);
      await this.d.git.deleteRefs(path, [...refs]);
    }
    this.d.checkpoints.delete(rows.map((c) => c.id));
  }

  /** Retention, applied after every capture. Refs go before rows: a row deleted first would leave a ref
   *  nothing knows about, which is the leak this whole policy exists to prevent. */
  private async prune(environmentId: string, path: string): Promise<void> {
    const doomed = this.d.checkpoints.prunable(environmentId, this.d.maxPerEnvironment ?? MAX_CHECKPOINTS_PER_ENVIRONMENT);
    if (doomed.length === 0) return;
    await this.d.git.deleteRefs(path, doomed.map((c) => c.ref));
    this.d.checkpoints.delete(doomed.map((c) => c.id));
  }

  /**
   * Whether restoring THIS checkpoint would also rewind the agent's memory of those turns.
   *
   * Five conditions, and each one is a different way the answer can honestly be no:
   *
   *  1. a rewind hook is wired at all — without one this build cannot truncate its own transcript, and
   *     a `true` here would promise something nothing in the process can do;
   *  2. the checkpoint belongs to a session, and that session still exists;
   *  3. that session's agent has a truncating resume (`AGENT_CONVERSATION_REWIND`);
   *  4. Realm knows where its own transcript stood — `sessionSeq`, null on every row written before
   *     this feature and on every capture taken outside a session;
   *  5. the provider cursor is complete AND still names the session's CURRENT provider session id.
   *     The SDK forks to a new id on every resume, so a cursor recorded before a restart describes a
   *     position in a chain the live session may no longer contain, and Realm will not guess.
   *
   * Condition 5 is also what makes a refusal permanent: the refusal clears the checkpoint's cursor, so
   * this answers false for that checkpoint from then on and nothing re-sends the rejected fork.
   */
  private rewindsConversation(cp: Checkpoint): boolean {
    if (!this.d.rewindSession) return false;
    if (!cp.sessionId || cp.sessionSeq === null) return false;
    const cursor = decodeProviderCursor(cp.providerCursor);
    if (!cursor) return false;
    const session = this.d.sessions.get(cp.sessionId);
    if (!session || !AGENT_CONVERSATION_REWIND[session.agentKind]) return false;
    return cursor.session === session.providerSessionId;
  }
}

/** The refusal, which must name what the caller was actually shown — a bare "unsafe" teaches nothing. */
export function describeRestore(p: RestorePreview): string {
  const parts: string[] = [];
  if (p.filesChanged > 0) parts.push(p.filesChanged === 1 ? "1 file" : `${p.filesChanged} files`);
  if (p.commitsRolledBack > 0) parts.push(p.commitsRolledBack === 1 ? "1 commit" : `${p.commitsRolledBack} commits`);
  if (parts.length === 0) return "the checkout has changed since you were shown this — nothing differs from the checkpoint now";
  return `the checkout has changed since you were shown this: restoring now would rewrite ${parts.join(" and ")} — confirm those exact counts to proceed`;
}
