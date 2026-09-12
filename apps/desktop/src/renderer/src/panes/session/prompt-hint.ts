import type { GitInfo, SessionStatus } from "@realm/contracts";
import type { Block } from "./transcript-model";

/**
 * The ONE prompt the prompter offers as its hint text — the placeholder the user is already reading,
 * which ⇥ fills in (Composer's `onKeyDown`).
 *
 * Still pure, and still read on every render of every visible session pane, so it still must not
 * call an agent. What changed is that it now takes a `generated` hint as an input: the model-written
 * one the server produces once per settled turn (`PromptHintService`), which arrives as a
 * `prompt_hint` event and is already in the transcript by the time this runs. The call happens on
 * the settle, not here — that ordering is the whole reason ⇥ still accepts a stable target.
 *
 * The rules below are the FLOOR, not the fallback of last resort: they answer while the generated
 * one is still in flight, on every build with no generator configured, on a machine with no Claude
 * CLI, and whenever the model declined to better them. That is most turns, so they are not dead
 * weight — they are what the prompter says when nothing more specific is true.
 *
 * The register is plain and SHORT on purpose — a handful of words, never a sentence carrying the
 * session's own text back at it. Every hint here used to embed the user's last request and, on a
 * failure, the error's message too, which produced things like
 * `Fix "EISDIR: illegal operation on a directory, read…" while working on give me a to…` — a line
 * nobody can read at a glance and nobody would accept with one key. The context belongs to the
 * session; the hint only has to name the next move.
 *
 * "Based on the current session" means literally that — the transcript's last turn, the working tree
 * and the mode, in that order of specificity.
 *
 * Returning `null` is a real answer, and the common one on a fresh session in a clean checkout: the
 * prompter keeps its plain "Ask anything". ⇥ promises something only when there is something
 * specific to promise.
 */
export function promptHint(ctx: {
  blocks: readonly Block[];
  gitInfo: GitInfo | null;
  status: SessionStatus;
  /** Session is in Plan — the agent is drafting, not doing. */
  inPlan: boolean;
  /** The model-written hint for the last settled turn, or null. Cleared by the reducer the moment
   *  the user sends anything, so a non-null value here is always about the turn on screen. */
  generated?: string | null;
}): string | null {
  const { blocks, gitInfo, status, inPlan } = ctx;
  // Mid-turn there is no "next prompt" yet: the thing the follow-up would be about is still being
  // written. The hint returns on its own the moment the turn settles. BEFORE the generated one is
  // consulted, because a hint written for the previous turn is not an answer about this one.
  if (status === "running" || status === "waiting_permission") return null;
  // It beat the floor or it would not exist: the generator is told to answer NONE rather than write
  // something generic, and a decline never becomes an event.
  if (ctx.generated) return ctx.generated;

  const reviewChanges = gitInfo && gitInfo.dirty > 0 ? freshChangesHint(gitInfo) : null;

  // Nothing has happened yet: the working tree is the only session-specific fact there is.
  if (blocks.length === 0) {
    if (reviewChanges) return reviewChanges;
    if (gitInfo && gitInfo.ahead > 0) return "Write a PR description.";
    return null;
  }

  // The last turn — everything after the last thing the user said.
  const lastUser = findLastIndex(blocks, (b) => b.kind === "user");
  const turn = blocks.slice(lastUser + 1);
  const files = filesIn(turn);

  /* Only a turn that ENDED badly offers to fix something.
     This used to fire on any errored tool call in the turn, which is the wrong reading of one: an
     agent that hits an EISDIR, notices, and goes on to answer the question has not failed — it has
     recovered, and the tool error is a step in a successful turn. Offering "Fix …" under a finished
     answer was the app inventing a problem, and quoting the error's text into the prompt made a
     long sentence out of it. The session's own status is the only thing that knows the difference. */
  if (status === "error") return "Find what went wrong and fix it.";

  // Plan mode: the agent has drafted; the next move is to do it. Gated on an actual plan block, not
  // on the agent merely having finished speaking — "which files should I look at?" is a completed
  // message too, and offering to implement a plan that does not exist promised nothing.
  if (inPlan && turn.some((b) => b.kind === "plan")) return "Build the plan.";

  /* It wrote a file. What to offer next depends on WHAT it wrote, which the extension knows and the
     tool name does not: "write tests for it" is a fine next move for a module and a nonsense one for
     an essay, and this app is used for both. Realm is not a coding tool that also opens documents —
     an agent here writes lectures, study guides and essays as often as it writes source. */
  if (turn.some((b) => b.kind === "tool" && WRITE_TOOLS.has(b.name))) {
    const one = files.length === 1 ? files[0]! : null;
    if (files.some(isProse)) return one ? `Tighten ${one}.` : "Tighten what you wrote.";
    if (files.some(isCode)) return one ? `Write tests for ${one}.` : "Write tests for the changes.";
    return one ? `Walk me through ${one}.` : "Walk me through what changed.";
  }

  // A read-only investigation left a trail. Follow it, without restating what was asked.
  if (files.length === 1) return `Walk me through ${files[0]}.`;
  if (files.length > 1) return "Walk me through what you found.";

  // A tool-free answer. The useful next move is to make it concrete — and "concrete" is an example,
  // which is true of an explanation about anything. It used to say "show me the code behind that",
  // which is a sentence about a codebase asked of a session that may never have had one.
  if (turn.some((b) => b.kind === "assistant" && !b.streaming)) return "Give me an example.";
  return reviewChanges;
}

/** Tools that CHANGE a file. Deliberately narrower than tool-group's `FILE_TOOLS`, which counts reads
 *  too — "it read four files" is not a reason to suggest running the tests. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);

/** Extensions that make a file PROSE — something you tighten, not something you test. */
const PROSE_EXT = new Set(["md", "markdown", "txt", "rtf", "tex", "csv", "docx", "pages", "html"]);
/** …and ones that make it code. Deliberately not "everything else": a `.zip` or a `.png` is neither,
 *  and offering to test one would be worse than offering nothing. */
const CODE_EXT = new Set(["ts", "tsx", "js", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cc", "cpp", "cs", "php", "sh", "sql", "css", "scss", "vue", "svelte"]);

const extOf = (name: string): string => {
  const base = name.split("/").pop() ?? name;
  return base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
};
const isProse = (name: string): boolean => PROSE_EXT.has(extOf(name));
const isCode = (name: string): boolean => CODE_EXT.has(extOf(name));

const PATH_TOOLS = new Set([...WRITE_TOOLS, "Read", "View", "read_file"]);

const freshChangesHint = (git: GitInfo): string => {
  const topic = branchTopic(git.branch);
  return topic ? `Review my ${topic} changes.` : "Review my changes.";
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

const findLastIndex = <T,>(xs: readonly T[], pred: (x: T) => boolean): number => {
  for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i]!)) return i;
  return -1;
};
