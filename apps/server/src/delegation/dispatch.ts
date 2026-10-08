import { AGENT_META, AGENT_SKILL_SUPPORT, AGENT_SUPPORTS_PERMISSION_MODES, PERMISSION_MODES, type AgentKind, type Environment } from "@realm/contracts";
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
 * The permission-mode rule here (`childPermissionMode`) is for children of a SESSION — `agent_run`
 * and the browser agent. A durable run has no parent session to be relative to; its rule is the flat
 * one in `RunConstraintsSchema`, where `bypassPermissions` is not a value, and it does not use this.
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

/** More restrictive = lower. A child is never given a mode that ranks above its parent's. An unranked
 *  mode (an adapter-specific string) ranks as `default`: capping over an unknown mode should fail
 *  toward asking, not toward access.
 *
 *  `ask` TIES with `plan` rather than sitting beside it. They are two different read-only modes, not
 *  two rungs of one ladder: neither lets the child change anything, so capping a child of one to the
 *  other is safe in both directions, and giving either a lower number would claim an ordering between
 *  them that does not exist. */
export const MODE_RANK: Record<string, number> = { plan: 0, ask: 0, default: 1, acceptEdits: 2, bypassPermissions: 3 };
export const rank = (mode: string): number => MODE_RANK[mode] ?? 1;

/** A mode as the prompter's chip names it: "Full access", not `bypassPermissions`. */
export function modeLabel(mode: string): string {
  if (mode === "plan") return "Plan";
  if (mode === "ask") return "Ask";
  return PERMISSION_MODES.find((m) => m.id === mode)?.label ?? mode;
}

export type ChildMode = {
  ok: true;
  /** What the child's row is written with. */
  mode: string;
  /** A request that asked for more than the parent has, and was held to the parent's mode. */
  capped: boolean;
  /** The child runs in exactly the parent's mode. */
  inherited: boolean;
  /** The harness takes no permission mode, so the row says `default` whatever the parent's is. */
  modeless: boolean;
};

/**
 * The mode a child of a session runs in: `min(parent, requested ?? parent)`. A request can only
 * tighten. A child of a Full access lead is Full access, because the person put the lead there and
 * the child is doing the lead's work; a child of an Ask-each-time lead asks, on its own session.
 *
 * One harness case is not a min. Realm cannot set a permission mode on some harnesses (Cursor and the
 * other ACP agents, `AGENT_SUPPORTS_PERMISSION_MODES`), so:
 *   - a READ-ONLY child there is refused, naming the harnesses that can be held to it — a row saying
 *     `plan` over an agent nothing restrains would be a promise Realm does not keep;
 *   - anything else is written as `default`, as `resolveDefaultPermissionMode` does for a new session,
 *     so the chip never claims a Full access Realm cannot deliver.
 */
export function childPermissionMode(parentMode: string, requested: string | undefined, childKind: AgentKind): ChildMode | Refusal {
  const wanted = requested ?? parentMode;
  const capped = rank(wanted) > rank(parentMode);
  const mode = rank(wanted) < rank(parentMode) ? wanted : parentMode;
  if (!AGENT_SUPPORTS_PERMISSION_MODES[childKind]) {
    if (rank(mode) === 0) {
      const can = (Object.keys(AGENT_SUPPORTS_PERMISSION_MODES) as AgentKind[])
        .filter((k) => AGENT_SUPPORTS_PERMISSION_MODES[k] && k !== "fake").map((k) => AGENT_META[k].label);
      return refuse(`refused: this sub-agent would run read-only (${modeLabel(mode)}), and Realm cannot hold ${AGENT_META[childKind].label} to a read-only mode. Run it on ${can.join(" or ")}, or leave the model out.`);
    }
    return { ok: true, mode: "default", capped, inherited: false, modeless: true };
  }
  return { ok: true, mode, capped, inherited: mode === parentMode, modeless: false };
}
