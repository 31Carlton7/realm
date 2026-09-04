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
    ? freshChangesHint(gitInfo)
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
  const request = lastUser >= 0 && blocks[lastUser]?.kind === "user"
    ? subjectOf(blocks[lastUser].text)
    : null;
  const files = filesIn(turn);

  // A failed tool or run names the actual thing that broke. Quoting its short detail is far more
  // useful than pointing vaguely upward at "that error".
  const last = blocks.at(-1);
  const failure = lastFailure(turn) ?? (last?.kind === "error" ? short(last.message, 68) : null);
  if (failure || status === "error") {
    const target = request ? ` while working on ${request}` : "";
    return failure
      ? `Investigate “${failure}”${target}, fix the root cause, and retry.`
      : `Find the failure${target}, fix the root cause, and retry.`;
  }

  // Plan mode: retain the subject that caused the plan and ask for the valuable second half of the
  // work too — testing its riskiest assumption. This reads like a continuation of this conversation,
  // not a stock button label.
  //
  // Gated on an actual plan block, not on the agent merely having finished speaking. "Which files
  // should I look at first?" is a completed assistant message too, and offering to implement the
  // plan under it promised a plan that did not exist. A `plan` event is the agent saying it has one.
  if (inPlan && turn.some((b) => b.kind === "plan")) {
    return request
      ? `Turn the plan for ${request} into working code, then verify its riskiest assumption.`
      : "Implement the plan, then verify its riskiest assumption.";
  }

  // It wrote code. Name what changed and why it changed; the files are taken from the actual tool
  // calls, while the subject comes from the user's latest request.
  if (turn.some((b) => b.kind === "tool" && WRITE_TOOLS.has(b.name))) {
    const where = files.length ? ` in ${joinFiles(files)}` : "";
    return request
      ? `Stress-test ${request}${where}, then fix what the tests expose.`
      : `Stress-test the changes${where}, then fix what the tests expose.`;
  }

  // A read-only investigation already established a trail through the repo. Offer to follow that
  // trail instead of collapsing back to the unrelated dirty-tree fallback.
  if (files.length && request) {
    return `Trace ${request} through ${joinFiles(files)}, then identify the highest-leverage change.`;
  }

  // Even a tool-free answer has a session-specific subject. The next useful move is to make the
  // answer concrete; this is intentionally absent when there was no user request to anchor it to.
  if (request && turn.some((b) => b.kind === "assistant" && !b.streaming)) {
    return `Take “${request}” further: show the concrete code path and its weakest edge case.`;
  }
  return reviewChanges;
}

/** Tools that CHANGE a file. Deliberately narrower than tool-group's `FILE_TOOLS`, which counts reads
 *  too — "it read four files" is not a reason to suggest running the tests. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);

const PATH_TOOLS = new Set([...WRITE_TOOLS, "Read", "View", "read_file"]);

/** Turn a request into a compact noun phrase that can be embedded in the next prompt. This is not
 *  pretending to understand prose: it only removes common conversational/action wrappers, preserves
 *  the user's own words, and declines noisy or tiny results. */
const subjectOf = (text: string): string | null => {
  let value = text.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  value = value
    .replace(/^(?:please\s+)?(?:can|could|would)\s+you\s+/i, "")
    .replace(/^(?:please\s+)?(?:help me\s+)?(?:add|build|create|debug|design|explain|fix|implement|improve|investigate|make|plan|refactor|review|test|update|write)\s+/i, "")
    .replace(/^(?:me|my|our|the|an?)\s+/i, "");
  if (/^[A-Z][a-z]/.test(value)) value = value[0]!.toLowerCase() + value.slice(1);
  value = short(value, 58);
  return value.length >= 4 ? value : null;
};

const freshChangesHint = (git: GitInfo): string => {
  const topic = branchTopic(git.branch);
  if (topic) return `Take a skeptical pass over the ${topic} work: find the edge case this diff is most likely to miss.`;
  const files = `${git.dirty} uncommitted ${git.dirty === 1 ? "file" : "files"}`;
  return `Audit the ${files} on ${git.branch}; find the edge case most likely to escape review.`;
};

/** main/master/develop carry no subject. A descriptive branch does, and is often the only context a
 *  brand-new session has, so turn `feature/pane-groups` into `pane groups`. */
const branchTopic = (branch: string): string | null => {
  const bare = branch.replace(/^(?:feature|feat|fix|bugfix|hotfix|chore|refactor)\//i, "");
  if (/^(?:main|master|develop|dev|trunk)$/i.test(bare)) return null;
  const topic = bare.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return topic || null;
};

const filesIn = (blocks: readonly Block[]): string[] => {
  const paths: string[] = [];
  for (const block of blocks) {
    if (block.kind !== "tool" || !PATH_TOOLS.has(block.name)) continue;
    const direct = [block.input.file_path, block.input.notebook_path, block.input.path]
      .find((value): value is string => typeof value === "string" && value.length > 0);
    if (direct) paths.push(direct);
    if (block.name === "apply_patch" && typeof block.input.patch === "string") {
      for (const match of block.input.patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)) paths.push(match[1]!);
    }
  }
  return [...new Set(paths.map(displayPath))].slice(0, 2);
};

const displayPath = (path: string): string => {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || path;
};

const joinFiles = (files: readonly string[]): string => files.length === 1
  ? files[0]!
  : `${files[0]} and ${files[1]}`;

const lastFailure = (blocks: readonly Block[]): string | null => {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "error") return short(block.message, 68);
    if (block.kind === "tool" && block.result?.isError) {
      const command = typeof block.input.command === "string" ? short(block.input.command, 52) : null;
      return command || short(block.result.content, 68) || `${block.name} failed`;
    }
  }
  return null;
};

const short = (text: string, max: number): string => {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const cut = oneLine.slice(0, max - 1);
  const word = cut.replace(/\s+\S*$/, "");
  return `${word.length >= Math.floor(max * .6) ? word : cut}…`;
};

const findLastIndex = <T,>(xs: readonly T[], pred: (x: T) => boolean): number => {
  for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i]!)) return i;
  return -1;
};
