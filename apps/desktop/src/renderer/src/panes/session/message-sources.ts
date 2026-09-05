import type { Block } from "./transcript-model";

export type Source = { url: string; host: string; path: string };

/**
 * The pages an answer was actually built from.
 *
 * A source here is a page the agent RETRIEVED, and that is a much narrower thing than a URL that
 * appears somewhere in the turn. Three kinds of near-source are deliberately refused:
 *
 *  - **Links in the assistant's prose.** A URL the model typed is a URL the model typed. It may be
 *    remembered, guessed, or wrong, and dressing it as a citation would launder a claim into
 *    evidence. Nothing in here reads the message text at all.
 *  - **`WebSearch`.** Its input is a query, not a page, and its result is a list of things the model
 *    was shown rather than things it read. The result is also a flattened string whose shape no
 *    contract in this repo pins, so parsing it would be guessing at a format that can change under
 *    us without a single test going red.
 *  - **Calls that failed or have not come back.** A fetch that errored retrieved nothing, and one
 *    still in flight has not retrieved it yet.
 *
 * What is left is the honest set: tools whose INPUT carries the url as structured data — `WebFetch`,
 * and the browser tools that point a pane at a page — that came back without an error. When no such
 * call ran in the turn, the answer has no sources, and the message says nothing rather than
 * inventing some.
 */
const FETCH_TOOLS = new Set(["WebFetch", "browser_open", "browser_navigate"]);

/** MCP tools reach the transcript fully prefixed (`mcp__<server>__realm-browser__browser_open`), and
 *  nothing in the renderer normalises them, so the bare name has to be recovered here. */
const bareToolName = (name: string): string => {
  const at = name.lastIndexOf("__");
  return at < 0 ? name : name.slice(at + 2);
};

const toSource = (url: string): Source | null => {
  try {
    const u = new URL(url);
    // http(s) only. A `file:` or `data:` url is not a page anyone can be cited to.
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { url, host: u.host.replace(/^www\./, ""), path: `${u.pathname}${u.search}`.replace(/\/$/, "") };
  } catch { return null; }
};

/**
 * The blocks belonging to the turn that produced the message at `index` — back to the user message
 * that started it, or to the beginning of the transcript.
 *
 * Scoped to the turn on purpose. A page fetched an hour ago, three questions back, is not what this
 * answer was built from, and listing it under this one would be the same overreach as scraping the
 * prose. Under-reporting is the safe direction here: a fetch whose turn boundary is ambiguous is
 * left out rather than attributed to an answer that may not have used it.
 */
export function turnBlocks(blocks: readonly Block[], index: number): readonly Block[] {
  let start = 0;
  for (let i = index - 1; i >= 0; i--) if (blocks[i]!.kind === "user") { start = i + 1; break; }
  return blocks.slice(start, index);
}

/** The sources for the assistant block at `index`, in the order the agent fetched them, deduped. */
export function sourcesFor(blocks: readonly Block[], index: number): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  for (const b of turnBlocks(blocks, index)) {
    if (b.kind !== "tool" || !FETCH_TOOLS.has(bareToolName(b.name))) continue;
    if (!b.result || b.result.isError) continue;
    const url = b.input["url"];
    if (typeof url !== "string") continue;
    const source = toSource(url);
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    out.push(source);
  }
  return out;
}
