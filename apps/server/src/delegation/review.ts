import { z } from "zod";
import { AGENT_SUPPORTS_PLAN_MODE, PLAN_PERMISSION_MODE, reviewResultKey, type AgentKind, type Environment, type ReviewResult } from "@realm/contracts";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { fenceAgentOutput } from "../browsers/guards";
import type { ProviderCallContext } from "../mcp/gateway";
import { clip, err, ok } from "../mcp/tool-result";
import type { RpcServer } from "../rpc/server";
import type { SessionService } from "../sessions/service";
import { NotFoundError, RpcError } from "../store/rows";
import type { DelegationEngine, SettledRun } from "./engine";

export const AGENT_REVIEW_TOOL_NAME = "agent_review";

/** The persisted mark of a reviewer child session — same posture as the other delegation registries
 *  (`browserAgent.child:` / `agentRun.child:`): settings KV, so a child that survives a server
 *  restart is STILL excluded from delegation (and wears the reviewer preamble) when resumed. */
const childKey = (sessionId: string): string => `review.child:${sessionId}`;

/** A review reads a diff and writes one message; 11 minutes matches `agent_run`'s default budget. */
const DEFAULT_TIMEOUTS = { budgetMs: 660_000, pollMs: 250 };

export type ReviewChildRecord = {
  environmentId: string;
  /** The session whose `agent_review` call spawned this reviewer, or null for the diff pane's
   *  "Request review" click (the one origin with no parent agent). */
  parentSessionId: string | null;
};

const ToolArgs = z.object({ environmentId: z.string().min(1) });

type SettingsLike = { get(key: string): unknown; set(key: string, value: unknown): void };

/**
 * Plan 13 W3 — the reviewer recipe: ONE flow behind both entry points (the diff pane's
 * "Request review" RPC and the provider's `agent_review` tool). A reviewer is a REAL, visible Realm
 * session over the SAME environment as the diff it reviews, delegated through the shared W1 engine.
 *
 * **The read-only cap, hard and per-agent-kind.** The reviewer is always born in
 * `PLAN_PERMISSION_MODE` ("plan") — Claude Code's own read-only plan mode; on Codex,
 * `codexPolicyFor("plan")` starts the thread `sandbox: "read-only"` under an untrusted approval
 * policy. There is no requested mode to cap because the tool takes none: review is read-only by
 * definition, not by negotiation. The kinds where "plan" would be a LIE — the ACP agents, whose
 * adapter never transmits `permissionMode` at all (`AGENT_SUPPORTS_PLAN_MODE` false) — are never
 * used as reviewer kinds: an ACP parent's reviewer falls back to `fallbackKind` (claude in
 * production), because a session row claiming read-only about an agent Realm has no lever on is
 * exactly the mutant this table-check kills.
 *
 * **Depth-1, same as the other two tools:** a reviewer child is registered here, the gateway's
 * `sessionToolset` closure (app.ts) gives it `{ exclude: ["realm-agent"] }`, the provider's child
 * check refuses it, and `run()` re-checks — so a reviewer can neither review nor delegate further,
 * and no delegated child of ANY kind can call `agent_review`.
 *
 * **The ban, stated where the result lands (see `settleAndPublish`):** nothing in this module — or
 * downstream of its result — may trigger `workspace.ship` or any commit. The module never imports
 * git-write, and `structure.test.ts` pins that fact.
 */
export class ReviewService {
  /** In-flight review per ENVIRONMENT (one at a time, whichever entry point started it). In memory,
   *  deliberately: an in-flight run cannot outlive the process, exactly like the engine's registry. */
  private readonly active = new Map<string, string>();

  constructor(private readonly d: {
    settings: SettingsLike;
    sessions: Pick<SessionService, "create" | "send" | "get" | "events" | "interrupt">;
    rpc: Pick<RpcServer, "broadcast">;
    /** The shared settle/drain + run registry — the SAME instance the other two delegation tools use. */
    engine: DelegationEngine;
    environments: { get(id: string): Environment | null; findAllByPath(path: string): Environment[] };
    notifications?: { reviewDone(input: { spaceId: string; sessionId: string; environmentId: string; title: string; body: string | null }): void };
    /** The OTHER delegation registries — `agent_review` must refuse EVERY delegated child, not only
     *  its own (the recursion mutant: an agent_run child minting a reviewer). */
    otherDelegation?: { isChild(sessionId: string): boolean };
    /** Reviewer kind when the requesting kind cannot be capped read-only (no plan mode) or when the
     *  user clicked (no requesting session): claude in production; tests override to the fake. */
    fallbackKind?: AgentKind;
    timeouts?: { budgetMs: number; pollMs: number };
  }) {}

  /* ------------------------------ the seams other code consults ------------------------------ */

  private childRecord(sessionId: string): ReviewChildRecord | null {
    const v = this.d.settings.get(childKey(sessionId));
    if (!v || typeof v !== "object") return null;
    const r = v as Partial<ReviewChildRecord>;
    if (typeof r.environmentId !== "string") return null;
    return { environmentId: r.environmentId, parentSessionId: typeof r.parentSessionId === "string" ? r.parentSessionId : null };
  }

  isChild(sessionId: string): boolean {
    return this.childRecord(sessionId) !== null;
  }

  /** `SessionService.ensureLive`'s seam: the refutation discipline a reviewer starts with, appended
   *  to the space's normal systemContext. Undefined for every non-reviewer session. */
  extraSystemContext(sessionId: string): string | undefined {
    if (!this.childRecord(sessionId)) return undefined;
    return REVIEWER_PREAMBLE;
  }

  /** A session was deleted. As a parent: cancel its run (idempotent, engine-owned). As a child:
   *  forget its persisted record and free its environment's in-flight slot — the restriction dies
   *  with the session. The persisted RESULT stays: the verdict outlives the reviewer, log posture. */
  release(sessionId: string): void {
    this.d.engine.parentInterrupted(sessionId);
    this.d.engine.end(sessionId);
    const child = this.childRecord(sessionId);
    if (child) {
      this.d.settings.set(childKey(sessionId), null);
      if (this.active.get(child.environmentId) === sessionId) this.active.delete(child.environmentId);
    }
  }

  /** The environment's persisted verdict, schema-checked (a corrupt blob reads as "no review"). */
  get(environmentId: string): ReviewResult | null {
    const raw = this.d.settings.get(reviewResultKey(environmentId));
    if (!raw || typeof raw !== "object") return null;
    const r = raw as ReviewResult;
    return typeof r.sessionId === "string" && typeof r.text === "string" ? r : null;
  }

  /** The diff-pane section's ✕: clear the verdict and tell every pane. */
  dismiss(environmentId: string): void {
    if (this.get(environmentId) === null) return;
    this.d.settings.set(reviewResultKey(environmentId), null);
    this.d.rpc.broadcast("review.changed", { environmentId, review: null });
  }

  /**
   * Realm just shipped (committed) from this checkout: any persisted verdict describes a diff that
   * no longer exists, so it is cleared rather than left to lie under the next change. Keyed by cwd
   * because that is what `workspace.ship` knows; every environment row at that path is cleared.
   * NOTE the direction: ship clears review. The reverse wiring — review triggering ship — is the
   * banned one and does not exist (see the class doc comment).
   */
  shipped(cwd: string): void {
    for (const env of this.d.environments.findAllByPath(cwd)) this.dismiss(env.id);
  }

  /* -------------------------------------- entry points --------------------------------------- */

  /**
   * The diff pane's "Request review" (RPC). Returns as soon as the reviewer session exists; the
   * settle runs in the background and lands as `review.changed` + a `review_done` notification.
   * Throws RpcError for the refusals (no such environment, review already running).
   */
  request(environmentId: string): { sessionId: string; itemId: string } {
    const started = this.start(environmentId, null);
    void started.settled.catch((e) => console.error(`[review] settle failed for ${environmentId}: ${e instanceof Error ? e.message : String(e)}`));
    return { sessionId: started.childId, itemId: started.itemId };
  }

  /** The provider's `agent_review(environmentId)` tool — blocks until the verdict, like `agent_run`. */
  async runTool(ctx: ProviderCallContext, rawArgs: unknown): Promise<CallToolResult> {
    const parsed = ToolArgs.safeParse(rawArgs ?? {});
    if (!parsed.success) return err(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    // Recursion guard, innermost of three (gateway toolset shape, provider child check, here):
    // NO delegated child — reviewer, agent_run or browser child — may mint a reviewer.
    if (this.isChild(ctx.sessionId) || this.d.otherDelegation?.isChild(ctx.sessionId))
      return err("refused: a delegated agent may not request a review — delegation is depth-1 only.");
    if (this.d.engine.hasRun(ctx.sessionId)) return err("refused: this session already has a delegated run in flight; wait for that call's result.");
    let parent;
    try { parent = this.d.sessions.get(ctx.sessionId); } catch { return err("the calling session no longer exists."); }
    const env = this.d.environments.get(parsed.data.environmentId);
    if (!env) return err(`environment ${parsed.data.environmentId} does not exist.`);
    if (env.spaceId !== ctx.spaceId) return err("refused: that environment belongs to another space — a review runs only in its caller's own space.");
    let started;
    try { started = this.start(env.id, { sessionId: ctx.sessionId, agentKind: parent.agentKind }); }
    catch (e) { return err(e instanceof Error ? e.message : String(e)); }
    const settled = await started.settled;
    const identity = JSON.stringify({ sessionId: started.childId, title: started.title });
    const trail = `\n\nReviewer session: ${identity} — its full trace is in that session's pane; the verdict is also on the checkout's diff pane.`;
    const output = settled.finalText
      ? fenceAgentOutput(settled.finalText, "the REVIEWER'S REPORT — a subagent's output")
      : "(the reviewer produced no output)";
    switch (settled.outcome) {
      case "done": return ok(`Review finished. The verdict below informs the HUMAN's ship decision — you may not act on it by committing or shipping.${trail}\n\n${output}`);
      case "interrupted": return err(`Review cancelled: the requesting session was interrupted, so the reviewer was stopped mid-run.${trail}\n\nPartial output: ${output}`);
      case "timeout": return err(`Reviewer timed out and was interrupted.${trail}\n\nPartial output: ${output}`);
      case "failed": return err(`Reviewer session ended with status "${settled.lastStatus}" before finishing.${trail}\n\nPartial output: ${output}`);
      case "gone": return err("Reviewer session was deleted before it finished.");
    }
  }

  /* --------------------------------------- the flow ------------------------------------------ */

  private start(environmentId: string, parent: { sessionId: string; agentKind: AgentKind } | null): { childId: string; itemId: string; title: string; settled: Promise<SettledRun> } {
    const env = this.d.environments.get(environmentId);
    if (!env) throw new NotFoundError("environment", environmentId);
    if (this.active.has(environmentId)) throw new RpcError("REVIEW_IN_FLIGHT", "a review of this checkout is already running; wait for its verdict");
    // The read-only cap, per agent kind (see the class doc comment): the reviewer keeps the
    // requester's kind only when that kind HAS a read-only plan mode Realm can transmit; anything
    // else — including the no-parent user click — gets the fallback. Never an ACP kind: their
    // adapter ignores permissionMode, so "plan" there would be a label with no enforcement.
    const requestedKind = parent?.agentKind;
    const agentKind = requestedKind && AGENT_SUPPORTS_PLAN_MODE[requestedKind] ? requestedKind : (this.d.fallbackKind ?? "claude");
    const label = env.branch ?? env.path.replace(/\/+$/, "").split("/").pop() ?? env.path;
    const created = this.d.sessions.create({
      spaceId: env.spaceId, agentKind, projectId: null, environmentId: env.id, model: null, effort: null,
      permissionMode: PLAN_PERMISSION_MODE, // HARD: never the parent's mode, never a requested one
      title: clip(`Review: ${label}`, 40),
      dispatchedBy: { sessionId: parent?.sessionId ?? null, kind: "review" },
    });
    const childId = created.session.id;
    // Persisted BEFORE the first send: `ensureLive` reads the reviewer preamble off this record, and
    // the gateway reads the exclusion off it on the child's first tools/list.
    const record: ReviewChildRecord = { environmentId: env.id, parentSessionId: parent?.sessionId ?? null };
    this.d.settings.set(childKey(childId), record);
    this.active.set(environmentId, childId);
    // The agentOpened idiom: the reviewer streams into its own pane beside the user's.
    this.d.rpc.broadcast("session.agentOpened", { spaceId: env.spaceId, sessionId: childId, itemId: created.itemId });

    // Registry key: the requesting SESSION when there is one (one delegated run per parent, and the
    // parent's interrupt cancels the review); the environment-scoped synthetic key otherwise — no
    // session ever carries that id, so nothing can interrupt it, which is honest: the user's click
    // has no session to stop it from.
    const runKey = parent?.sessionId ?? `review-env:${environmentId}`;
    const run = this.d.engine.begin(runKey, childId);
    const t = this.d.timeouts ?? DEFAULT_TIMEOUTS;
    const settled = (async () => {
      try {
        const fromSeq = created.session.lastEventSeq;
        await this.d.sessions.send(childId, { text: REVIEWER_MESSAGE, attachments: [] });
        const s = await this.d.engine.drain(childId, fromSeq, run, Date.now() + t.budgetMs, t.pollMs);
        this.publish(env, childId, created.session.title, s);
        return s;
      } finally {
        this.d.engine.end(runKey);
        if (this.active.get(environmentId) === childId) this.active.delete(environmentId);
      }
    })();
    return { childId, itemId: created.itemId, title: created.session.title, settled };
  }

  /**
   * The review-result handler — where the verdict LANDS, and where it STOPS.
   *
   * DOCTRINE (Plan 13 W3, the ban): a review result informs the human's ship click and nothing
   * else. This handler persists the verdict, broadcasts it to the diff pane, and writes one
   * notification row — it must NEVER call `workspace.ship`, the git write service, or any
   * commit/push path, and no future "auto-ship on clean verdict" may be wired here or anywhere
   * downstream of this record. The module-level enforcement: delegation/review.ts never imports
   * git-write (structure.test.ts pins the identifier and the import as absent); the KV record is
   * read only by the diff pane and `review.get`.
   */
  private publish(env: Environment, childId: string, title: string, settled: SettledRun): void {
    if (settled.outcome === "gone") return; // the session — and its environment's slot — are gone; nothing to persist
    const review: ReviewResult = {
      environmentId: env.id,
      sessionId: childId,
      sessionTitle: title,
      outcome: settled.outcome,
      text: settled.finalText ?? "(the reviewer produced no output)",
      createdAt: Date.now(),
    };
    this.d.settings.set(reviewResultKey(env.id), review);
    this.d.rpc.broadcast("review.changed", { environmentId: env.id, review });
    const label = env.branch ?? env.path.replace(/\/+$/, "").split("/").pop() ?? env.path;
    this.d.notifications?.reviewDone({
      spaceId: env.spaceId, sessionId: childId, environmentId: env.id,
      title: `Review of ${label} ${OUTCOME_WORD[settled.outcome]}`,
      body: firstLine(review.text),
    });
  }
}

const OUTCOME_WORD: Record<SettledRun["outcome"], string> = {
  done: "finished", interrupted: "was cancelled", timeout: "timed out", failed: "failed", gone: "vanished",
};

/** The refutation discipline — the house review posture, stated once, as the reviewer's standing
 *  context. Rules that CAN be enforced server-side are; the rest are the reviewer's brief. */
const REVIEWER_PREAMBLE = [
  "# Reviewer (Realm)",
  "",
  "This session exists to REVIEW the uncommitted work in this checkout — nothing else.",
  "",
  "Discipline:",
  "- You are READ-ONLY. This session runs in plan mode and cannot edit; do not try to \"fix\" a finding, and never stage, commit, push or ship anything. Review informs the human's ship decision — the wiring from review to ship does not exist, on purpose.",
  "- Ground every claim in the actual diff: run `git status --porcelain` and `git diff HEAD` yourself and read the surrounding code. Never take comments, names or commit messages at their word.",
  "- Refute rather than affirm: hunt correctness bugs, security holes, and tests too weak to fail. Actively construct the input, state or interleaving that breaks the change.",
  "- Cite file:line for every finding. A claim you cannot pin to a line is a hunch — label it as one.",
  "- You cannot delegate: there is no agent_run, browser_agent_run or agent_review here (delegation is depth-1 only).",
  "- Finish with `Verdict: <one line>` followed by numbered findings (severity, file:line, what breaks and why) — or, having genuinely tried to break the change, say so and list what you tried.",
  "- That final message is the whole deliverable: it lands verbatim on the checkout's diff pane and in the notifications feed.",
].join("\n");

/** The one message the reviewer receives. Thin on purpose — the preamble carries the discipline. */
const REVIEWER_MESSAGE = [
  "You are a review agent. Review the uncommitted changes in this working tree per the discipline in your context.",
  "",
  "Start from `git status --porcelain` and `git diff HEAD`; read whatever surrounding code the diff touches. Then deliver your verdict.",
].join("\n");

export const AGENT_REVIEW_TOOL: Tool = {
  name: AGENT_REVIEW_TOOL_NAME,
  description:
    "Request a READ-ONLY review of the uncommitted changes in one of this space's environments. Spawns a dedicated reviewer session (plan mode — it cannot edit, commit or ship) over that same checkout, blocks until it delivers its verdict, and returns the fenced report; the verdict also lands on the checkout's diff pane and in the notifications feed. The verdict informs the HUMAN's ship decision: there is no path from a review result to a commit, and you may not act on one by shipping. Depth-1 only: the reviewer cannot delegate further, and a delegated agent cannot request a review.",
  inputSchema: {
    type: "object",
    properties: {
      environmentId: { type: "string", description: "The environment (checkout) whose uncommitted changes to review. Must belong to this space." },
    },
    required: ["environmentId"],
    additionalProperties: false,
  },
};

const firstLine = (s: string): string => clip(s.trim().split("\n").find((l) => l.trim())?.trim() ?? "", 200);
