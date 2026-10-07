import { readFileSync } from "node:fs";
import { LayaEvalReportSchema, type LayaAssistGate, type LayaEvalReport, type LayaMode } from "@realm/contracts";
import type { ObservedElement } from "../mcp/act-observer";
import type { LayaClient } from "./client";
import { pickCandidates, sensitiveRule, targetQuestion } from "./shadow";

/**
 * Laya's say, where it has earned one: the element an agent DESCRIBED, picked from the live screen.
 *
 * The shadow asks Laya about every step and tells nobody. This is the one place its answer is used,
 * and it is fenced three times over. The mode must be `assist`, which the service refuses to enter
 * until the ACTIVE checkpoint's held-out evaluation clears the bar (`LayaService.assistGate`). The
 * pick must reach the confidence that evaluation fitted for high precision. And the step must not be
 * one the sensitive rule flags: a payment, a deletion, a message, a secret is never Laya's to choose,
 * however sure it is — those go back to the agent, by number, with the reason.
 *
 * Every other outcome is a list, never a guess: the likeliest candidates from the fresh read, which
 * the agent picks from by number. So the worst Assist can do is cost the agent the round trip it
 * would have made anyway.
 */

/** How long the action path waits for Laya before handing the choice back — it is IN the step. */
export const ASSIST_BUDGET_MS = 1_500;
/** laya-serve answers one question at a time; a busy answer is retried this often within the budget. */
const BUSY_RETRY_MS = 60;

export type AssistOutcome =
  /** Laya's pick clears the threshold and the step is not sensitive: act on it. */
  | { kind: "pick"; element: ObservedElement; confidence: number; ms: number }
  /** Hand the choice back: the candidates, the best guess if there was one, and why. */
  | { kind: "ask-agent"; candidates: ObservedElement[]; best: { element: ObservedElement; confidence: number } | null; why: "unsure" | "sensitive" | "no-answer" | "no-candidates"; matched?: string };

export type LayaAssist = {
  /** Whether a description may be used as a target right now, and why not. */
  gate(): LayaAssistGate;
  /** Resolve `description` against `elements` (the screen as just read) in `app`, the app on screen
   *  when the tool knows it. Never throws. */
  resolve(description: string, intent: string, elements: readonly ObservedElement[], tool: string, app?: string): Promise<AssistOutcome>;
};

export function createLayaAssist(d: {
  laya: { currentMode(): LayaMode; client(): LayaClient | null; assistGate(): LayaAssistGate };
  budgetMs?: number;
  now?: () => number;
}): LayaAssist {
  const budget = d.budgetMs ?? ASSIST_BUDGET_MS;
  const now = d.now ?? (() => performance.now());
  const gate = (): LayaAssistGate => {
    if (d.laya.currentMode() !== "assist") return { available: false, reason: "Laya is not in Assist mode.", threshold: null, accuracy: null };
    const g = d.laya.assistGate();
    if (!g.available) return g;
    if (!d.laya.client()) return { ...g, available: false, reason: "Laya is not running right now." };
    return g;
  };
  return {
    gate,
    async resolve(description, intent, elements, tool, app) {
      const candidates = pickCandidates(elements, null, description);
      if (candidates.length === 0) return { kind: "ask-agent", candidates, best: null, why: "no-candidates" };
      const g = gate();
      const client = d.laya.client();
      if (!g.available || g.threshold === null || !client) return { kind: "ask-agent", candidates, best: null, why: "no-answer" };
      const q = targetQuestion(description, candidates, tool);
      const started = now();
      let answer: { id: string; confidence: number; ms: number } | null = null;
      while (answer === null && now() - started < budget) {
        try {
          const left = Math.max(100, budget - (now() - started));
          const { answers, ms } = await client.ask(q.state, q.questions, left);
          const a = answers.target;
          if (a?.type !== "choice") break;
          const id = q.idOf.get(a.choice);
          if (id !== undefined) answer = { id, confidence: a.confidence, ms: Math.round(ms) };
          break;
        } catch (e) {
          // Busy is the one failure worth waiting out; anything else hands the choice back now.
          if (!/\b503\b|busy/i.test(e instanceof Error ? e.message : String(e))) break;
          await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
        }
      }
      if (!answer) return { kind: "ask-agent", candidates, best: null, why: "no-answer" };
      const element = candidates.find((c) => c.id === answer!.id);
      if (!element) return { kind: "ask-agent", candidates, best: null, why: "no-answer" };
      const best = { element, confidence: answer.confidence };
      // Sensitive first: a confident pick of "Buy" is still not Laya's to make.
      const rule = sensitiveRule(`${intent} ${description} ${element.label}`, app);
      if (rule.value) return { kind: "ask-agent", candidates, best, why: "sensitive", ...(rule.matched ? { matched: rule.matched } : {}) };
      if (answer.confidence < g.threshold) return { kind: "ask-agent", candidates, best, why: "unsure" };
      return { kind: "pick", element, confidence: answer.confidence, ms: answer.ms };
    },
  };
}

/**
 * For live checks only: an evaluation forced in by path, so Assist's mechanics can be exercised
 * before any checkpoint has earned it. Honored ONLY in a harness (`REALM_ENABLE_FAKE_AGENT=1`, the
 * flag every live check boots with) — no user's Realm can have its Assist gate opened by an
 * environment variable. The real source is the active checkpoint's own `eval.json`.
 */
export function harnessEvalOverride(env: NodeJS.ProcessEnv = process.env): (() => LayaEvalReport | null) | undefined {
  const path = env.REALM_LAYA_EVAL_OVERRIDE?.trim();
  if (env.REALM_ENABLE_FAKE_AGENT !== "1" || !path) return undefined;
  return () => {
    try {
      const r = LayaEvalReportSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  };
}
