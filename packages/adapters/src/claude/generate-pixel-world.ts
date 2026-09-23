import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

type QueryFn = typeof sdkQuery;

/** What the caller knows and the model needs: the furniture it may place, grouped as the catalog
 *  groups it. Passed in rather than imported so this stays a text-in/text-out call — the catalog is
 *  built from decoded sprites in the renderer, and reaching for it here would drag a canvas into the
 *  server process. */
export type WorldVocabulary = { category: string; ids: string[] }[];

export type PixelWorldRequest = {
  prompt: string;
  vocabulary: WorldVocabulary;
  /** The world on screen now, as room text, when the ask is a change rather than a fresh start. */
  current?: { room: string[]; name: string } | null;
  /** How big a room may be. The caller's limit, restated to the model so it does not have to be
   *  told twice by a refusal. */
  maxCols: number;
  maxRows: number;
  /** How many agents need somewhere to sit. A room built for six and handed twelve puts half of
   *  them on the floor, and the model cannot know the number unless it is told. */
  seats?: number;
  /** How many props it may ask to have drawn. Zero turns the feature off. */
  maxDrawn?: number;
  /** What was wrong with its last attempt, fed straight back. Present only on a retry. */
  problems?: string[];
};

/**
 * One description in, one office out.
 *
 * Deliberately NOT `ClaudeAdapter` — the same reasoning as `generateSvgIcon`, which this follows:
 * that class runs a full interactive coding session, and this needs one sentence in and one JSON
 * object out. `maxTurns: 1`, no tools, no MCP, and the cheap model, because drawing a room out of a
 * fixed vocabulary is not a task a frontier model does better.
 *
 * **The room is asked for as text, not as numbers.** The engine wants a flat array of `cols × rows`
 * tile integers; asking a model for one means asking it to keep an exact count of 300-odd numbers
 * while imagining a floor plan, and an off-by-one there is invisible in the answer and a hole in the
 * floor on screen. Drawn as rows of characters the shape IS the data, the model can see its own
 * mistakes, and `expandRoom` does the counting. Measured against the alternative in the obvious way:
 * this format cannot produce a ragged room without it being visible in the output.
 *
 * Returns the model's raw JSON text. It is NOT validated here on purpose — `checkWorld` and
 * `checkTheme` live next to the renderer that has to survive the answer, and a second, weaker copy
 * of those rules on the server is how the two come to disagree about what is safe.
 */
export async function generatePixelWorld(req: PixelWorldRequest, deps: { query?: QueryFn } = {}): Promise<string> {
  const query = deps.query ?? sdkQuery;
  const vocab = req.vocabulary.map((g) => `${g.category}: ${g.ids.join(", ")}`).join("\n");
  const current = req.current
    ? `\n\nThe office on screen right now is called ${JSON.stringify(req.current.name)} and looks like this:\n${req.current.room.join("\n")}\n\nChange it as asked; keep whatever the request does not mention.`
    : "";
  /* A retry is the same ask with the refusal attached. A model told exactly which row was short
     fixes it; a model told "that did not work" guesses, and usually guesses the same thing. */
  const retry = req.problems?.length
    ? `\n\nYour last attempt was rejected for these reasons. Fix all of them:\n${req.problems.map((p) => `- ${p}`).join("\n")}`
    : "";
  const drawn = (req.maxDrawn ?? 0) > 0 ? [
    "",
    `  "draw": OPTIONAL. Up to ${req.maxDrawn} props that DO NOT exist in the list above but that the`,
    "            request needs — a highway shield, a state flag, a domed building, a neon sign.",
    '            Each is { "id", "label", "prompt" }: a SHORT_UPPER_SNAKE id, a human label, and a',
    "            sentence describing the object to be drawn. They are drawn for you and become",
    '            placeable — refer to them in "furniture" by the id you gave, exactly.',
    "            Use this whenever the request names something specific. A room asked to be about a",
    "            place and built only out of desks and plants has not answered the request.",
  ].join("\n") : "";
  const q = query({
    prompt: `Design a pixel-art office for: ${req.prompt}${current}${retry}`,
    options: {
      maxTurns: 1,
      allowedTools: [],
      model: "claude-haiku-4-5",
      systemPrompt: [
        "You design small top-down pixel-art rooms for a tool that shows coding agents working in an office.",
        "Answer with ONE JSON object and nothing else — no markdown fences, no prose.",
        "",
        "The object has exactly these keys:",
        '  "name": a short title for the room, 2-4 words.',
        '  "theme": { "name", "floor", "wall", "carpet"(optional) } — each of floor/wall/carpet is',
        '            { "h", "s", "b", "c", "colorize" }. With "colorize": true, h is 0-360 and s is',
        "            0-100 and the sprite's own colour is REPLACED — use this for a strong mood.",
        "            With colorize false or absent, h is -180..180 and s is -100..100 and the values",
        "            SHIFT what the sprite already had. b and c are -100..100 in both modes.",
        '  "room": an array of equal-length strings, one per row, drawing the floor plan.',
        "            '#' is wall, '.' is empty space outside the room, '1'-'9' are nine floor",
        "            patterns — pick one or two and use them consistently; they are patterns, not",
        "            colours, and the theme is what colours them.",
        '  "furniture": an array of { "type", "col", "row" } placing pieces by top-left tile,',
        "            0-indexed from the room's top-left corner.",
        drawn,
        "",
        `The room may be at most ${req.maxCols} columns by ${req.maxRows} rows, and should USE that`,
        "space — a large room with distinct areas reads far better than a small crowded one. Build",
        "enclosed space: a wall border with floor inside. Interior walls are encouraged; two or three",
        "connected rooms with doorways between them (leave a gap in the wall) beat one big hall.",
        "Give different areas different floor patterns so they read as different rooms.",
        `Seat at least ${req.seats ?? 6} agents: put that many desks against walls, each with a free`,
        "tile in front of it to sit on. Leave walkable floor between furniture — the characters walk",
        "around, and a room packed wall to wall gives them nowhere to go.",
        "",
        "Use ONLY these furniture types, exactly as spelled:",
        vocab,
        "",
        (req.maxDrawn ?? 0) > 0
          ? [
              'Never invent a furniture type in "furniture". If the request needs something the list',
              'does not have, ASK FOR IT in "draw" and then place it by the id you gave it. That is',
              "what `draw` is for, and a request about a specific place or thing is exactly when to",
              "use it: a room built out of the generic list alone has not answered such a request.",
            ].join("\n")
          : [
              "Never invent a furniture type. If the request asks for something not in the list,",
              "build the nearest thing out of what IS in the list and say nothing about it.",
            ].join("\n"),
      ].join("\n"),
    },
  });
  let text = "";
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(`world generation failed: ${msg.subtype}`);
      text = msg.result;
    }
  }
  const json = extractJson(text);
  if (!json) throw new Error("world generation returned no JSON object");
  return json;
}

/** Strips markdown fences and any prose around the model's answer down to the `{...}` span. A model
 *  told not to use fences still does sometimes, and refusing a good answer over its wrapper would be
 *  a refusal the user cannot act on. */
export function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end < start) return null;
  return text.slice(start, end + 1).trim();
}
