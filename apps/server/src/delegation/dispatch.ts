import { AGENT_SKILL_SUPPORT, type AgentKind, type Environment } from "@realm/contracts";
import type { SkillsService } from "../skills/service";

/**
 * The dispatch recipe, extracted (Plan 18 W1) — the three resolutions every flow that spawns a
 * worker session has to do before `sessions.create`: which agent kind, which skills, which checkout.
 *
 * Extracted rather than forked, for the reason `DelegationEngine` was: `agent_run` and durable runs
 * both need "an existing environment XOR a fresh worktree, and clean up the worktree if the session
 * then fails to exist", and two copies of that is how exactly one of them starts leaking orphan
 * worktrees. `structure.test.ts` pins the single-copy fact.
 *
 * What is deliberately NOT here: permission-mode capping. `agent_run`'s cap is parent-relative
 * (min(parent's effective, requested)) and a durable run has no parent session to be relative to —
 * its rule is the flat one in `RunConstraintsSchema`, where `bypassPermissions` is not a value.
 * Sharing a "capping" helper between those two would mean inventing a fake parent for runs, and a
 * safety line that has to be lied to in order to be reused is the wrong abstraction.
 */

/** A resolution that failed, carrying the words the caller shows verbatim. Callers phrase their own
 *  wrapper (an MCP `isError` result, an RpcError) — only the reason is shared. */
export type Refusal = { ok: false; message: string };
export type Resolved<T> = { ok: true; value: T };
export type Resolution<T> = Resolved<T> | Refusal;

const refuse = (message: string): Refusal => ({ ok: false, message });
const resolved = <T>(value: T): Resolved<T> => ({ ok: true, value });

/**
 * Which agent the worker runs as: an explicit request wins; otherwise the requesting session's own
 * kind, but only when that kind can take Realm's skills injection — a kind that cannot gets the
 * fallback (claude in production) so the worker is not silently deprived of the space's skills.
 * `parentKind` null (no requesting session at all — a durable run created from the UI) also falls
 * back, which is the same branch, not a special case.
 */
export function resolveAgentKind(requested: AgentKind | undefined, parentKind: AgentKind | null, fallback: AgentKind | undefined): AgentKind {
  if (requested) return requested;
  if (parentKind && AGENT_SKILL_SUPPORT[parentKind] === "injected") return parentKind;
  return fallback ?? "claude";
}

/**
 * Skills narrowing: the requested set must be a SUBSET of the space's enabled-and-valid skills, and
 * an id that is not refuses the whole call loudly rather than silently staging nothing — a worker
 * quietly missing the one skill it was given the task for is the failure this refusal exists to
 * prevent. Returns `null` for "no narrowing" (the space's full enabled set).
 */
export function resolveSkillSubset(
  spaceId: string,
  requested: string[] | undefined,
  skills: Pick<SkillsService, "list">,
): Resolution<string[] | null> {
  if (!requested) return resolved(null);
  const enabled = new Set(skills.list(spaceId).skills.filter((s) => s.enabled && s.valid).map((s) => s.id));
  const unknown = requested.filter((id) => !enabled.has(id));
  if (unknown.length > 0) {
    return refuse(`refused: constraints.skills must be a subset of this space's enabled skills — not enabled here: ${unknown.join(", ")}.`);
  }
  return resolved([...new Set(requested)]);
}

export type EnvironmentDeps = {
  /** Throws (NotFoundError) for an unknown id — the store's own posture. */
  get(id: string): Environment;
  createWorktree(input: { spaceId: string; title: string | null; from: string | null }): Promise<Environment>;
  removeWorktree(id: string, acknowledge: null): Promise<void>;
};

export type EnvironmentChoice = {
  /** Null = neither was asked for; `sessions.create` puts the worker in the space's primary. */
  environmentId: string | null;
  /** The worktree this call CREATED, or null. The caller must `cleanupWorktree` it if the session it
   *  was made for then fails to exist — see that function. */
  created: Environment | null;
};

/**
 * Where the worker runs: an EXISTING environment of this space, a fresh worktree, or (neither) the
 * space's primary. Mutually exclusive, refused here where the refusal can be worded properly.
 *
 * The same-space check is duplicated in `SessionsStore.create` on purpose — two write-path guards,
 * one invariant. This one exists so the refusal names the real reason instead of surfacing as a
 * generic create failure.
 */
export async function resolveEnvironment(
  spaceId: string,
  opts: { environmentId?: string | undefined; newWorktree?: boolean | string | undefined; worktreeTitle: string | null },
  environments: EnvironmentDeps,
  /** The caller's own words. `what` names the worker in the worktree-failure message; `ownership` is
   *  the whole "X runs only in …" clause, because a delegated agent runs in its CALLER's space while
   *  a run just runs in its own — a shared resolver must not flatten that distinction into one
   *  sentence that is subtly wrong for one of them. */
  words: { what: string; ownership: string },
): Promise<Resolution<EnvironmentChoice>> {
  const wantsWorktree = opts.newWorktree !== undefined && opts.newWorktree !== false;
  if (opts.environmentId !== undefined && wantsWorktree) {
    return refuse("refused: constraints.environmentId and constraints.newWorktree are mutually exclusive — name an existing environment OR ask for a fresh worktree.");
  }
  if (opts.environmentId) {
    let env: Environment;
    try { env = environments.get(opts.environmentId); }
    catch { return refuse(`environment ${opts.environmentId} does not exist.`); }
    if (env.spaceId !== spaceId) return refuse(`refused: that environment belongs to another space — ${words.ownership}.`);
    return resolved({ environmentId: env.id, created: null });
  }
  if (wantsWorktree) {
    const title = typeof opts.newWorktree === "string" ? opts.newWorktree : opts.worktreeTitle;
    let created: Environment;
    try { created = await environments.createWorktree({ spaceId, title, from: null }); }
    catch (e) { return refuse(`could not create a worktree for ${words.what}: ${errorMessage(e)}`); }
    return resolved({ environmentId: created.id, created });
  }
  return resolved({ environmentId: null, created: null });
}

/**
 * Remove a worktree that was created for a session which then failed to exist. A worktree made for a
 * session that does not exist is an orphan environment; a FRESH worktree is clean, so removal
 * succeeds. Best effort either way — the UI can remove it too, and throwing here would replace a
 * useful "the session could not be created" with a confusing cleanup error.
 */
export async function cleanupWorktree(created: Environment | null, environments: Pick<EnvironmentDeps, "removeWorktree">): Promise<void> {
  if (!created) return;
  try { await environments.removeWorktree(created.id, null); } catch { /* visible in the UI */ }
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
