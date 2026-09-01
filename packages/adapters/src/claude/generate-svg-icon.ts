import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

type QueryFn = typeof sdkQuery;

/**
 * One-shot prompt-in/text-out icon generation, deliberately NOT `ClaudeAdapter` — that class runs a
 * full interactive streaming session (permission bridging, MCP servers, tool-call events) for a
 * multi-turn coding agent. This just needs one description in and one SVG out, so it calls the SDK's
 * `query()` directly: `maxTurns: 1`, no tools, no MCP servers, cheapest model in the fleet (an icon
 * is a handful of shapes, not a task that benefits from a frontier model).
 *
 * Rides the same `claude auth login` credentials every Claude session already uses — no separate API
 * key. Throws on any non-success result (error, refusal, max-turns) or an empty response; callers
 * decide how to surface that.
 */
export async function generateSvgIcon(prompt: string, deps: { query?: QueryFn } = {}): Promise<string> {
  const query = deps.query ?? sdkQuery;
  const q = query({
    prompt: `Design a small, simple icon for: ${prompt}\n\nRespond with ONLY a single <svg> element, nothing else — no markdown fences, no explanation.`,
    options: {
      maxTurns: 1,
      allowedTools: [],
      model: "claude-haiku-4-5",
      systemPrompt: [
        "You generate a single square icon as raw SVG markup, in the style of a small, clean, modern app icon —",
        "a few flat shapes, not a photorealistic illustration.",
        "Output ONLY the <svg>...</svg> markup: no markdown code fences, no prose before or after.",
        'The root element must be exactly one <svg viewBox="0 0 48 48" ...>.',
        "Use only <svg>, <path>, <circle>, <ellipse>, <rect>, <line>, <polygon>, <polyline>, <g>, <defs>,",
        "<linearGradient>, <radialGradient>, <stop> elements with fill/stroke/geometry attributes.",
        "Never emit <script>, <foreignObject>, <image>, event handler attributes (onload, onclick, ...),",
        "or any external reference (href, xlink:href, url(...) pointing outside a local gradient id).",
      ].join(" "),
    },
  });
  let text = "";
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(`icon generation failed: ${msg.subtype}`);
      text = msg.result;
    }
  }
  const svg = extractSvg(text);
  if (!svg) throw new Error("icon generation returned no SVG markup");
  return svg;
}

/** Strips markdown fences and any prose around the model's answer down to the `<svg>...</svg>` span. */
function extractSvg(text: string): string | null {
  const start = text.indexOf("<svg");
  const end = text.lastIndexOf("</svg>");
  if (start < 0 || end < 0 || end < start) return null;
  return text.slice(start, end + "</svg>".length).trim();
}
