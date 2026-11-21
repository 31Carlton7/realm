import { ClaudeLiveAnswers, type LiveAnswerModel, type LiveAnswerRequest, generateHandoffNotes, generateMemoryExtraction, generateMemoryTidyPlan, generateSessionRecap, generateSessionTitle } from "@realm/adapters";

/**
 * The server's own billed model calls — a model-written sidebar title on a session's first message,
 * a recap when a turn settles, what Realm learns from a quiet session for memory and the pass that keeps
 * that memory tidy, the hand-off note a switch of agents writes — or none at all.
 *
 * None while the scripted agent is enabled. That flag is how every live check and capture boots the
 * BUILT app (`REALM_ENABLE_FAKE_AGENT=1`, "offline dev" in `defaultAdapters`), and those boot this
 * entry rather than a bare `createApp` — so without this, each one sent its first message to a model
 * on the user's own account and left a transcript for a scratch folder in `~/.claude/projects`,
 * while `SessionsDeps.titleGenerator` promised a harness would never make that call. A harness gets
 * the heuristic first-line title instead, which is all any live check reads, and learns nothing.
 *
 * A live check that needs a recap on screen adds `REALM_FAKE_RECAP=1` and gets one written from
 * Realm's own counts, with no model call.
 */
export function billedGenerators(env: NodeJS.ProcessEnv = process.env): {
  titleGenerator?: typeof generateSessionTitle; summaryGenerator?: typeof generateSessionRecap; handoffGenerator?: typeof generateHandoffNotes;
  memoryLearning?: { extract: typeof generateMemoryExtraction; tidy: typeof generateMemoryTidyPlan };
} {
  if (env.REALM_ENABLE_FAKE_AGENT === "1") return env.REALM_FAKE_RECAP === "1" ? { summaryGenerator: scriptedRecap } : {};
  return {
    titleGenerator: generateSessionTitle, summaryGenerator: generateSessionRecap, handoffGenerator: generateHandoffNotes,
    memoryLearning: { extract: generateMemoryExtraction, tidy: generateMemoryTidyPlan },
  };
}

async function scriptedRecap({ facts }: { facts: string }): Promise<{ summary: string; hint: string | null }> {
  return { summary: `Scripted recap: ${facts.split("\n").map((l) => l.replace(/^- /, "")).join(", ")}.`, hint: null };
}

/**
 * What a meeting's live answers run on: the person's Claude login, or under the scripted agent a
 * scripted answer, so a live check that opens the meeting panel neither starts a Claude Code process
 * nor sends a transcript anywhere. A live check that needs the real engine (pointed at a stand-in
 * API) asks for it with `REALM_REAL_LIVE_ANSWERS=1`.
 */
export function liveAnswerModel(env: NodeJS.ProcessEnv = process.env): LiveAnswerModel {
  if (env.REALM_ENABLE_FAKE_AGENT === "1" && env.REALM_REAL_LIVE_ANSWERS !== "1") return new ScriptedLiveAnswers();
  return new ClaudeLiveAnswers();
}

export const SCRIPTED_LIVE_ANSWER = ["Scripted answer: ", "twelve seats ", "to start, ", "on the annual plan."];

export class ScriptedLiveAnswers implements LiveAnswerModel {
  constructor(private readonly tickMs = 30) {}

  prepare(): void {}

  async answer(req: LiveAnswerRequest): Promise<string> {
    for (const piece of SCRIPTED_LIVE_ANSWER) {
      await new Promise((r) => setTimeout(r, this.tickMs));
      if (req.signal.aborted) throw new Error("cancelled");
      req.onText(piece);
    }
    return SCRIPTED_LIVE_ANSWER.join("");
  }

  release(): void {}

  close(): void {}
}
