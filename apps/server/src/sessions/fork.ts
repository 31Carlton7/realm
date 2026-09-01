import { existsSync } from "node:fs";
import type { Environment, Session } from "@realm/contracts";
import type { CheckpointsStore } from "../store/checkpoints";
import type { EnvironmentsStore } from "../store/environments";
import type { SessionsStore, SessionEventsStore } from "../store/sessions";
import type { SettingsStore } from "../store/settings";
import type { EnvironmentService } from "../environments/service";
import type { WorktreeService } from "../workspace/worktrees";
import type { CheckpointGit } from "../workspace/checkpoints";
import type { RpcServer } from "../rpc/server";
import type { CreateSessionInput } from "./service";
import { TITLE_MAX } from "./service";
import { NotFoundError, RpcError } from "../store/rows";

/**
 * The cap on ancestor transcript carried into a fork, in characters (~6k tokens). Truncation keeps
 * the TAIL — the turns nearest the checkpoint are the context the fork is forking from — and the
 * carried text SAYS it was truncated and to what, because a silently shortened memory is the failure
 * mode this whole feature exists to be honest about.
 */
export const FORK_CONTEXT_MAX = 24_000;

/** The settings key holding one forked session's carried context, read on every adapter start. */
export const forkContextKey = (sessionId: string): string => `fork.context:${sessionId}`;

/**
 * The fenced summary-of-ancestor a forked session starts with.
 *
 * Plain speech turns only (user/assistant text — tool chatter is bulk, not context), fenced with a
 * backtick run longer than any in the content so transcript text can never break out of the block.
 * The header states the one hard truth of this feature: the provider conversation CANNOT be rewound
 * (`AGENT_CONVERSATION_REWIND` is false for every adapter Realm ships), so this is a workspace fork
 * with context carried as text — the same sentence the UI shows.
 */
export function buildForkContext(input: {
  ancestorTitle: string; checkpointLabel: string;
  turns: { role: "user" | "assistant"; text: string }[];
  max?: number;
}): string {
  const max = input.max ?? FORK_CONTEXT_MAX;
  const blocks = input.turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`);
  let body = blocks.join("\n\n");
  let truncated = false;
  if (body.length > max) {
    // Keep the tail; cut forward to the next turn boundary so the carried text never opens mid-block.
    const tail = body.slice(body.length - max);
    const boundary = tail.indexOf("\n\n");
    body = boundary === -1 ? tail : tail.slice(boundary + 2);
    truncated = true;
  }
  const fence = "`".repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map((r) => r.length + 1)));
  const carried = input.turns.length === 0
    ? "The ancestor had no conversation before that checkpoint, so no transcript is carried."
    : `The ancestor transcript up to that checkpoint is carried below as plain text${truncated
      ? ` — truncated to its newest ${max.toLocaleString("en-US")} characters; earlier turns are omitted`
      : ""}.`;
  return [
    "# Forked session",
    `This session was forked from "${input.ancestorTitle}" at the checkpoint "${input.checkpointLabel}". ` +
    "The fork restored the WORKSPACE: this checkout is a new worktree matching that checkpoint's files. " +
    "The provider conversation could not be rewound, so this is a fresh conversation. " + carried,
    ...(input.turns.length === 0 ? [] : [`${fence}transcript\n${body}\n${fence}`]),
  ].join("\n\n");
}

/** `Fork: <ancestor title>`, clipped to the same TITLE_MAX every other title obeys. */
export function forkTitle(ancestorTitle: string): string {
  const t = `Fork: ${ancestorTitle}`;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t;
}

export type ForkDeps = {
  checkpoints: CheckpointsStore;
  environments: EnvironmentsStore;
  envService: EnvironmentService;
  worktrees: WorktreeService;
  sessionsStore: SessionsStore;
  events: SessionEventsStore;
  settings: SettingsStore;
  git: CheckpointGit;
  rpc: RpcServer;
  /** SessionService.create, injected as a seam (the service depends back on this one for the fork
   *  context, the late-bound-closure knot app.ts ties everywhere). */
  createSession: (input: CreateSessionInput) => { session: Session; itemId: string };
};

/**
 * "Fork from here" (Plan 16 W3).
 *
 * The cardinal rule, stated where it is enforced: **the ancestor is never touched.** The restore
 * machinery runs against a worktree this service just created (`CheckpointGit.extract`), never
 * against the checkpoint's own environment — the ancestor's worktree, session row, events and
 * checkpoint refs are all left byte-identical. What the fork produces is additive only: one
 * worktree, one environment row, one session (+item), one settings row carrying the context.
 */
export class ForkService {
  constructor(private d: ForkDeps) {}

  /** The carried context for a forked session, re-injected on every adapter start of that session
   *  (the same standing-context posture memory docs have). Undefined for every other session. */
  extraSystemContext(sessionId: string): string | undefined {
    const v = this.d.settings.get(forkContextKey(sessionId));
    return typeof v === "string" && v.length > 0 ? v : undefined;
  }

  /** Forget a deleted session's carried context — wired into the session-release fan-out. */
  release(sessionId: string): void {
    this.d.settings.set(forkContextKey(sessionId), null);
  }

  async fork(checkpointId: string): Promise<{ session: Session; itemId: string; environment: Environment }> {
    const cp = this.d.checkpoints.require(checkpointId);
    if (!cp.sessionId) {
      throw new RpcError("FORK_NO_SESSION", "this checkpoint was not taken by a session's turn, so there is no session to fork");
    }
    const ancestor = this.d.sessionsStore.get(cp.sessionId);
    if (!ancestor) {
      throw new RpcError("FORK_SESSION_GONE", "the session this checkpoint belongs to has been deleted; there is nothing to fork");
    }
    const env = this.d.environments.get(cp.environmentId);
    if (!env) throw new NotFoundError("environment", cp.environmentId);
    if (!existsSync(env.path) || !await this.d.git.isRepository(env.path)) {
      throw new RpcError("NOT_A_REPOSITORY", `${env.path} is not a git repository any more; the checkpoint cannot be forked`);
    }
    if (!await this.d.git.refIntact(env.path, cp.ref, cp.commitSha)) {
      throw new RpcError("CHECKPOINT_GONE", "this checkpoint's git objects are no longer in the repository");
    }

    // The carried context is built BEFORE anything is created: it reads only the ancestor's rows, and
    // a failure here (there isn't one to have, but discipline) must not leave a half-made fork.
    const context = buildForkContext({
      ancestorTitle: ancestor.title, checkpointLabel: cp.label,
      turns: this.d.events.transcript(ancestor.id, cp.createdAt),
    });

    // A NEW worktree, branched from the ancestor environment's HEAD (Plan 7's seam — the same repo,
    // whose shared ref store is what lets `extract` resolve the checkpoint's trees from inside it)…
    const forked = await this.d.envService.createWorktree({
      spaceId: env.spaceId, title: forkTitle(ancestor.title), from: env.id,
    });
    let session: Session, itemId: string;
    try {
      // …restored to the checkpoint's captured state. `extract`, NEVER `restore`: restore's cwd
      // would be the ancestor's checkout, and rewriting that in place is the one thing a fork must
      // be incapable of.
      await this.d.git.extract({ cwd: forked.path, state: cp.state });

      ({ session, itemId } = this.d.createSession({
        spaceId: env.spaceId, projectId: null, agentKind: ancestor.agentKind,
        model: ancestor.model, effort: ancestor.effort, permissionMode: ancestor.permissionMode,
        environmentId: forked.id, title: forkTitle(ancestor.title),
        dispatchedBy: { kind: "fork", sessionId: ancestor.id },
      }));
    } catch (e) {
      // Unwind the fresh worktree (made moments ago, handed to nobody) rather than strand it. The
      // ancestor needs no unwinding — nothing above wrote to it.
      await this.d.worktrees.discard(env.path, forked.path, forked.branch ?? "").catch(() => {});
      try { this.d.environments.delete(forked.id); } catch { /* the original error is the one to report */ }
      throw e;
    }
    this.d.settings.set(forkContextKey(session.id), context);
    this.d.rpc.broadcast("environments.changed", { spaceId: env.spaceId });
    return { session, itemId, environment: this.d.environments.get(forked.id) ?? forked };
  }
}
