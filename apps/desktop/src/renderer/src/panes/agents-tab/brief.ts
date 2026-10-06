/**
 * The message the Agents tab sends: the user asking THIS session's agent to hand work out.
 *
 * Sent as an ordinary user message, not as a tool call made on the agent's behalf, and that is the
 * design rather than a shortcut: the session's own agent stays the orchestrator — it splits the work,
 * starts the sub-agents, reads their reports and answers for them — and the transcript shows the
 * request in the user's own words, beside everything the agent did about it.
 *
 * So the words have to work on ANY model reading them. They name the tool and the field
 * (`agent_start`, `constraints.model`) and write each model by the name the server resolves, because
 * a model that has to guess how delegation works in Realm will sometimes guess "I'll just do it
 * myself", which is the one outcome this composer exists to prevent.
 */

/** One model the user picked: its name as the server resolves it, whether it is the session's own
 *  model (which takes no name at all), and the part of the work it was given, if any. */
export type BriefPick = { label: string; own: boolean; task: string };

/** Whether there is enough here to send: a model, and something for it to do. Split tasks can be the
 *  whole of the work, so the shared text may be empty when every model has its own. */
export function canSend(work: string, picks: readonly BriefPick[], split: boolean): boolean {
  if (picks.length === 0) return false;
  if (work.trim() !== "") return true;
  return split && picks.every((p) => p.task.trim() !== "");
}

const nameOf = (p: BriefPick): string => (p.own ? `your own model (${p.label})` : p.label);

/** How to start one: by name, or — the session's own model — by leaving the name out. */
const howOf = (p: BriefPick): string => (p.own ? "leave constraints.model out" : `constraints.model "${p.label}"`);

function list(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function delegationBrief({ work, picks, split, fromPlan = false }: {
  work: string;
  picks: readonly BriefPick[];
  /** Each pick carries its own part of the work, rather than leaving the split to the agent. */
  split: boolean;
  /** The work is a plan the session already wrote — said so, so the agent builds THAT plan rather
   *  than drafting a new one. */
  fromPlan?: boolean;
}): string {
  const body = work.trim();
  const heading = fromPlan ? "The plan:" : "The work:";
  const tail = body === "" ? "" : `\n\n${heading}\n\n${body}`;
  const collect = "Start every one before you wait on any, collect their reports with agent_wait, and then tell me what each one did and anything left to do.";
  const worktrees = "If they would edit the same files, give each its own worktree (constraints.newWorktree).";

  if (picks.length === 1 && !(split && picks[0]!.task.trim() !== "")) {
    const p = picks[0]!;
    return `Build this with a sub-agent on ${nameOf(p)}: start it with agent_start (${howOf(p)}) and tell me what it did when it reports back.${tail}`;
  }
  if (split) {
    const lines = picks.map((p) => `- ${p.own ? `Your own model (${p.label}), with constraints.model left out` : p.label}: ${p.task.trim() || "a part of the work below that you choose"}`);
    return [
      `Build this with sub-agents, one per task below. Start each with agent_start and set constraints.model to the model named for it. ${collect} ${worktrees}`,
      "",
      ...lines,
    ].join("\n") + tail;
  }
  const names = picks.map(nameOf);
  const own = picks.find((p) => p.own);
  const ownNote = own ? ` For ${nameOf(own)}, leave constraints.model out.` : "";
  return `Build this with sub-agents on ${list(names)}. Split the work into independent parts, one for each model, and start each with agent_start, setting constraints.model to that model's name.${ownNote} ${collect} ${worktrees}${tail}`;
}
