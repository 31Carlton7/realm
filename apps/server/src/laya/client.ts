import { performance } from "node:perf_hooks";
import { z } from "zod";

/**
 * Realm's side of `laya-serve`'s wire: `GET /health` and `POST /v1/systemone`, which is all the
 * server has — the Jev decision protocol (`laya/serve.py`), not a `/predict` route.
 *
 * Every request says `model: "english"`. Left to route, the server picks the multilingual checkpoint
 * for text it reads as non-English — a checkpoint that is not loaded and, offline, not on disk — so a
 * French window title would turn one question into a failed load. Naming the checkpoint also makes
 * the one a logged row names the one that answered.
 */

const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.number()), confidence: z.number(),
});
const NoulAnswerSchema = z.object({ type: z.literal("noul"), noul: z.number(), confidence: z.number() });
const AnswersSchema = z.object({ answers: z.record(z.union([ChoiceAnswerSchema, NoulAnswerSchema])) });
const HealthSchema = z.object({
  status: z.string(),
  loaded: z.array(z.string()),
  revisions: z.record(z.string().nullable()).default({}),
  device: z.string(),
  checkpoint_devices: z.record(z.string()).default({}),
});

export type LayaChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;
export type LayaNoulAnswer = z.infer<typeof NoulAnswerSchema>;
export type LayaHealth = z.infer<typeof HealthSchema>;
export type LayaQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string };

/** The one checkpoint Realm runs (see `runtime.ts`). */
export const LAYA_CHECKPOINT = "english";

export class LayaClient {
  constructor(private readonly d: {
    baseUrl: string;
    apiKey: string;
    fetchImpl?: typeof fetch;
    /** Each question's round trip, for the p50 Settings shows. */
    onLatency?: (ms: number) => void;
  }) {}

  async health(timeoutMs: number): Promise<LayaHealth> {
    const res = await this.fetch("/health", { method: "GET" }, timeoutMs);
    return HealthSchema.parse(await res.json());
  }

  /**
   * One state, one or more questions, one forward pass. `ms` is the whole round trip as Realm saw it
   * — what a step would have waited, had anything waited — not the server's inference time alone.
   * `record: false` keeps a warm-up out of the latency Settings reports.
   */
  async ask(state: string, questions: Record<string, LayaQuestion>, timeoutMs: number, record = true): Promise<{ answers: Record<string, LayaChoiceAnswer | LayaNoulAnswer>; ms: number }> {
    const t0 = performance.now();
    const res = await this.fetch("/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.d.apiKey}` },
      body: JSON.stringify({ state, questions, model: LAYA_CHECKPOINT }),
    }, timeoutMs);
    const { answers } = AnswersSchema.parse(await res.json());
    const ms = performance.now() - t0;
    if (record) this.d.onLatency?.(ms);
    return { answers, ms };
  }

  private async fetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const fetchImpl = this.d.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(`${this.d.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") throw new Error(`laya-serve did not answer within ${timeoutMs} ms`);
      throw e;
    }
    if (!res.ok) {
      // FastAPI's own `{"detail": …}`, which for a 422 names the question and what is wrong with it.
      const body = await res.text().catch(() => "");
      let detail = body;
      try { detail = String((JSON.parse(body) as { detail?: unknown }).detail ?? body); } catch { /* not JSON */ }
      throw new Error(`laya-serve answered ${res.status}: ${detail.slice(0, 200)}`);
    }
    return res;
  }
}
