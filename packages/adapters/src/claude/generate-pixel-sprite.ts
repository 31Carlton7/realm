import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { extractJson } from "./generate-pixel-world";

type QueryFn = typeof sdkQuery;

export type PixelSpriteRequest = {
  prompt: string;
  /** How big the piece may be, in pixels. One tile is 16; the caller's cap, restated to the model. */
  maxWidth: number;
  maxHeight: number;
};

/**
 * One description in, one piece of pixel furniture out.
 *
 * Same shape as `generatePixelWorld` and for the same reasons: one turn, no tools, the cheap model,
 * raw JSON back for the renderer to validate. What differs is the ask — this draws rather than
 * arranges — and so does the format.
 *
 * **A palette, then rows of characters.** The alternative is a grid of hex strings, and a 32×32
 * piece is a thousand of them: slow, expensive, and impossible for a model to keep rectangular. Over
 * a named palette the piece is small enough that the model can see its own shape while drawing it,
 * the colours are committed to once instead of a thousand times, and a short row is visibly short.
 *
 * The sprite is drawn top-down, because that is the projection the office is in. Saying so matters:
 * asked for "a chair" without it, a model draws a chair in elevation, which in this office is a
 * chair lying on its back.
 */
export async function generatePixelSprite(req: PixelSpriteRequest, deps: { query?: QueryFn } = {}): Promise<string> {
  const query = deps.query ?? sdkQuery;
  const q = query({
    prompt: `Draw this as a small top-down pixel-art object: ${req.prompt}`,
    options: {
      maxTurns: 1,
      allowedTools: [],
      model: "claude-haiku-4-5",
      systemPrompt: [
        "You draw small pixel-art props for a top-down office game, in the style of a 16-bit SNES game:",
        "chunky, readable at a glance, a handful of flat colours with one darker shade for shadow and",
        "one lighter for highlight. No outlines around the whole shape, no gradients, no dithering.",
        "",
        "The view is TOP-DOWN and slightly angled, as if looking down at a desk from above and in",
        "front — you see the top surface of things, and a little of their front face. A chair is seen",
        "from above with its back at the top. Never draw an object side-on.",
        "",
        "Answer with ONE JSON object and nothing else — no markdown fences, no prose:",
        '  "name": what it is, 1-3 words.',
        '  "palette": an object of single-character keys to "#RRGGBB" colours. Use 4-8 colours.',
        "             The character `.` is reserved and means transparent; do not define it.",
        '  "pixels": an array of equal-length strings, one per row, each character either `.` or a',
        "             key from the palette.",
        "",
        `The piece may be at most ${req.maxWidth} pixels wide and ${req.maxHeight} tall, and should`,
        "fill most of that. Leave the corners transparent if the shape is round. Every row must be",
        "exactly the same length — the rows ARE the image, and a short one is a bite out of it.",
      ].join("\n"),
    },
  });
  let text = "";
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(`sprite generation failed: ${msg.subtype}`);
      text = msg.result;
    }
  }
  const json = extractJson(text);
  if (!json) throw new Error("sprite generation returned no JSON object");
  return json;
}
