import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

type QueryFn = typeof sdkQuery;

const TITLE_MAX = 40;

/**
 * One-shot prompt-in/title-out summary, same shape as `generateSvgIcon`: calls the SDK's `query()`
 * directly instead of running a full `ClaudeAdapter` session — `maxTurns: 1`, no tools, cheapest
 * model in the fleet (a sidebar title does not need a frontier model).
 *
 * Rides the same `claude auth login` credentials every Claude session already uses. Throws on any
 * non-success result (error, refusal, max-turns) or an empty response; callers decide how to
 * surface that — session titling treats it as a nicety and swallows the failure.
 */
export async function generateSessionTitle(text: string, deps: { query?: QueryFn } = {}): Promise<string> {
  const query = deps.query ?? sdkQuery;
  const q = query({
    prompt: `Write a short sidebar title for a coding session that opens with this request:\n\n${text}`,
    options: {
      maxTurns: 1,
      allowedTools: [],
      model: "claude-haiku-4-5",
      systemPrompt: [
        "You write short titles that summarize a coding assistant's chat session for a sidebar list.",
        "Respond with ONLY the title text: no quotes, no markdown, no trailing punctuation, no",
        'prefix like "Title:". Use plain sentence case, not Title Case. Keep it under 6 words.',
      ].join(" "),
    },
  });
  let result = "";
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(`title generation failed: ${msg.subtype}`);
      result = msg.result;
    }
  }
  const title = cleanTitle(result);
  if (!title) throw new Error("title generation returned no text");
  return title;
}

/** Strips wrapping quotes/punctuation the model tends to add, and re-applies the same clip
 *  `titleFromMessage` uses so an LLM title can never make the sidebar row any wider than the
 *  heuristic one it replaces. */
function cleanTitle(text: string): string {
  const one = text.trim().split("\n").find((l) => l.trim()) ?? "";
  const stripped = one.replace(/\s+/g, " ").trim().replace(/^["'“”]+|["'“”]+$/g, "").replace(/[.!?]+$/g, "").trim();
  return stripped.length > TITLE_MAX ? `${stripped.slice(0, TITLE_MAX - 1).trimEnd()}…` : stripped;
}
