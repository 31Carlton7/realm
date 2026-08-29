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
    let checkpoint: Checkpoint;
    try {
      checkpoint = this.d.checkpoints.create({ id, environmentId: env.id, sessionId: input.sessionId, kind: input.kind, label: input.label, ref, state });
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
      return await this.capture({ environmentId: session.environmentId, sessionId, kind: "turn", label: labelFrom(text) });
    } catch (e) {
      onLog?.(`[checkpoints] capture failed for session ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** What restoring would cost, and whether the checkpoint is still usable at all. */
  async preview(id: string): Promise<RestorePreview> {
    const cp = this.d.checkpoints.require(id);
    const env = this.environment(cp.environmentId);
    const base = {
      checkpointId: cp.id, environmentId: env.id, path: env.path, label: cp.label, createdAt: cp.createdAt,
      rewindsConversation: this.rewindsConversation(cp.sessionId),
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
      conversationRewound: false, // no adapter can; see AGENT_CONVERSATION_REWIND
    };
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
    const doomed = this.d.checkpoints.prunable(environmentId, MAX_CHECKPOINTS_PER_ENVIRONMENT);
    if (doomed.length === 0) return;
    await this.d.git.deleteRefs(path, doomed.map((c) => c.ref));
    this.d.checkpoints.delete(doomed.map((c) => c.id));
  }

  /** Whether restoring would also rewind the agent's memory of those turns. False for every adapter
   *  Realm ships — the table says why, and the UI says so out loud rather than pretending. */
  private rewindsConversation(sessionId: string | null): boolean {
    if (!sessionId) return false;
    const session = this.d.sessions.get(sessionId);
    return session ? AGENT_CONVERSATION_REWIND[session.agentKind] : false;
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
