import type { GitInfo, SessionStatus } from "@realm/contracts";
import type { Block } from "./transcript-model";

/**
 * The ONE prompt the prompter offers as its hint text — the placeholder the user is already reading,
 * which ⇥ fills in (Composer's `onKeyDown`). Pure and deterministic on purpose: this is read on every
 * render of every visible session pane, so it must not call an agent, and a suggestion that changed
 * under the user between renders would be a moving target for the key that accepts it.
 *
 * "Based on the current session" means literally that — the transcript's last turn, the working tree
 * and the mode, in that order of specificity. Nothing here falls back to `suggestions.ts`: those
 * static starters are the hero's chips, sitting two inches below this line, and the one thing this
 * feature could make worse is saying the same sentence twice in the same view.
 *
 * So returning `null` is a real answer, and the common one on a fresh session in a clean checkout:
 * the prompter keeps its plain "Ask <agent> anything…" and the chips keep the offer. ⇥ promises
 * something only when there is something specific to promise.
 */
export function promptHint(ctx: {
  blocks: readonly Block[];
  gitInfo: GitInfo | null;
  status: SessionStatus;
  /** Session is in Plan — the agent is drafting, not doing. */
  inPlan: boolean;
}): string | null {
  const { blocks, gitInfo, status, inPlan } = ctx;
  // Mid-turn there is no "next prompt" yet: the thing the follow-up would be about is still being
  // written. The hint returns on its own the moment the turn settles.
  if (status === "running" || status === "waiting_permission") return null;

  const reviewChanges = gitInfo && gitInfo.dirty > 0
    ? `Review my uncommitted changes on ${gitInfo.branch} for bugs and style issues.`
    : null;

  // Nothing has happened yet: the working tree is the only session-specific fact there is. Work in
  // flight outranks work already committed — uncommitted changes are the thing still being decided.
  if (blocks.length === 0) {
    if (reviewChanges) return reviewChanges;
    if (gitInfo && gitInfo.ahead > 0) {
      return `Write a PR description for the ${gitInfo.ahead} ${gitInfo.ahead === 1 ? "commit" : "commits"} on ${gitInfo.branch}.`;
    }
    return null;
  }

  // The last turn — everything after the last thing the user said. An agent-opened transcript (no
  // user block at all) is its own single turn.
  const lastUser = findLastIndex(blocks, (b) => b.kind === "user");
  const turn = blocks.slice(lastUser + 1);

  // A turn that ended in an error is the one case where the next prompt is not a choice.
  if (blocks[blocks.length - 1]?.kind === "error" || status === "error") return "Fix that error and try again.";
  // Plan mode: the agent has just written a plan and cannot act on it. Saying go is the whole gesture.
  if (inPlan && turn.some((b) => b.kind === "assistant" && !b.streaming)) return "Go ahead and implement that plan.";
  // It wrote code. What is not yet known is whether the code works.
  if (turn.some((b) => b.kind === "tool" && WRITE_TOOLS.has(b.name))) return "Run the tests and fix anything that fails.";
  return reviewChanges;
}

/** Tools that CHANGE a file. Deliberately narrower than tool-group's `FILE_TOOLS`, which counts reads
 *  too — "it read four files" is not a reason to suggest running the tests. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);

const findLastIndex = <T,>(xs: readonly T[], pred: (x: T) => boolean): number => {
  for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i]!)) return i;
  return -1;
};
