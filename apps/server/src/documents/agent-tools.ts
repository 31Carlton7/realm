import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { GUIDES_DIR, LECTURES_DIR, progressSidecarPath, weakTopics, type DocumentEntry, type GuideProgress } from "@realm/contracts";
import type { ProviderCallContext, RealmToolProvider } from "../mcp/gateway";
import { clip, err, ok } from "../mcp/tool-result";
import type { McpService } from "../mcp/service";
import { searchDocs, SEARCH_MAX_LIMIT } from "./docs-search";
import type { TextExtractor } from "./text-extract";

export const DOCS_PROVIDER_NAME = "realm-docs";

/**
 * The `realm-docs` gateway provider (Plan 22 W2): the agent tool surface over a space's documents.
 *
 * Small on purpose, following Plan 17 W6's rule — anything a file edit can do is NOT a tool here.
 * An agent writes a guide or extends lecture notes with its own Write/Edit tools and the pane shows
 * the result live. What files cannot express is the three things below:
 *
 *   - `docs_search`   — what the course folder says about something: every lecture, guide, deck
 *                       (PDF text included) that mentions the query, ranked, with snippets. This is
 *                       what lets a session in EE 457 cite lecture 4 instead of guessing.
 *   - `docs_open`     — put a file on the user's screen ("look at this guide"). Surfaces the
 *                       documents pane and opens the tab; the file itself is not touched.
 *   - `docs_progress` — a guide's quiz history from its sidecar, so "make me a review guide for
 *                       what I keep getting wrong" has data behind it.
 *
 * Plus `docs_list`, because a search needs a folder name to scope to and "what lectures exist" is
 * a question every wrap-up pass asks first. All four are read-only except `docs_open`, which
 * changes only what is on screen — none prompts for permission.
 */
export type DocsAgentToolsDeps = {
  mcp: Pick<McpService, "providerEnabled">;
  extractor: TextExtractor;
  /** The space's primary checkout — where lectures/ and guides/ live. Null when the space is gone. */
  rootForSpace(spaceId: string): string | null;
  /** `DocumentService.list` over the space's primary workspace (creating the workspace if needed). */
  listForSpace(spaceId: string, dir: string): Promise<DocumentEntry[]>;
  /** `DocumentService.openPath` — the same call the store makes. */
  openPath(p: { spaceId: string; path: string }): Promise<{ documentsId: string; itemId: string; environmentId: string }>;
  /** A guide's sidecar (empty when none). */
  progressForSpace(spaceId: string, path: string): Promise<GuideProgress>;
};

export function createDocsAgentProvider(d: DocsAgentToolsDeps): RealmToolProvider {
  return {
    name: DOCS_PROVIDER_NAME,
    async tools(ctx: ProviderCallContext): Promise<Tool[]> {
      if (!d.mcp.providerEnabled(ctx.spaceId, DOCS_PROVIDER_NAME)) return [];
      return TOOLS;
    },
    async call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult> {
      if (!d.mcp.providerEnabled(ctx.spaceId, DOCS_PROVIDER_NAME))
        return err(`the ${DOCS_PROVIDER_NAME} tools are disabled for this space — mcp.setProviderEnabled turns them back on.`);
      const handler = HANDLERS[tool];
      if (!handler) return err(`unknown tool "${tool}" — this provider has: ${TOOLS.map((t) => t.name).join(", ")}`);
      try {
        return await handler(d, ctx, (args ?? {}) as Record<string, unknown>);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

const TOOLS: Tool[] = [
  {
    name: "docs_search",
    description: `Search this space's folder — lecture notes, study guides, slide decks and problem sets (PDF text included) — for files mentioning every word of the query. Returns ranked paths with snippets. Use it before answering a question about the course so the answer cites what the course actually said. Read-only.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "words to find; every word must appear" },
        dir: { type: "string", description: `folder to scope to, e.g. "${LECTURES_DIR}" or "${GUIDES_DIR}" (default: whole space)` },
        limit: { type: "number", description: `max hits (default 10, max ${SEARCH_MAX_LIMIT})` },
      },
      required: ["query"], additionalProperties: false,
    },
  },
  {
    name: "docs_list",
    description: `List a folder of this space (default: the root). Lectures live in "${LECTURES_DIR}/", guides in "${GUIDES_DIR}/". Read-only.`,
    inputSchema: { type: "object", properties: { dir: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "docs_open",
    description: "Show a file in the user's Documents pane — a guide you just wrote, the lecture you are summarizing. Opens a tab; changes nothing on disk. Path is relative to the space folder.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "docs_progress",
    description: "A study guide's quiz history (best and last score per topic, attempts) from its progress sidecar, plus which topics are weak. Use it to target a review guide. Read-only.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "the guide's .html path" } }, required: ["path"], additionalProperties: false },
  },
];

type Handler = (d: DocsAgentToolsDeps, ctx: ProviderCallContext, a: Record<string, unknown>) => Promise<CallToolResult>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const SNIPPET_MAX = 240;

const HANDLERS: Record<string, Handler> = {
  async docs_search(d, ctx, a) {
    const query = str(a.query).trim();
    if (!query) return err("query is required");
    const root = d.rootForSpace(ctx.spaceId);
    if (!root) return err("this space has no folder");
    const limit = typeof a.limit === "number" && Number.isFinite(a.limit) ? a.limit : undefined;
    const dir = str(a.dir).replace(/^\/+|\/+$/g, "");
    const res = await searchDocs(root, query, d.extractor, { dir: dir || undefined, limit });
    if (res.hits.length === 0) {
      return ok(`No file under ${dir || "the space folder"} mentions all of: ${query}. (${res.scanned} files scanned${res.truncated ? ", scan truncated" : ""}.)`);
    }
    const lines = res.hits.map((h, i) => {
      const snip = h.snippet.map((s) => (s.match ? `[${s.text}]` : s.text)).join("").replace(/\s+/g, " ");
      return `${i + 1}. ${h.path}${h.kind === "pdf" ? " (pdf)" : ""}\n   ${clip(snip, SNIPPET_MAX)}`;
    });
    const note = res.truncated ? `\n(scan truncated at the file cap; narrow with dir)` : "";
    return ok(`${res.hits.length} hit${res.hits.length === 1 ? "" : "s"} for "${query}" (${res.scanned} files scanned):\n${lines.join("\n")}${note}`);
  },
  async docs_list(d, ctx, a) {
    const dir = str(a.dir).replace(/^\/+|\/+$/g, "");
    const entries = await d.listForSpace(ctx.spaceId, dir);
    if (entries.length === 0) return ok(`${dir || "/"} is empty`);
    return ok(entries.map((e) => (e.isDir ? `${e.path}/` : `${e.path} (${e.size} bytes)`)).join("\n"));
  },
  async docs_open(d, ctx, a) {
    const path = str(a.path).replace(/^\/+/, "");
    if (!path) return err("path is required");
    const r = await d.openPath({ spaceId: ctx.spaceId, path });
    return ok(`Opened ${path} in the Documents pane (workspace ${r.documentsId}).`);
  },
  async docs_progress(d, ctx, a) {
    const path = str(a.path).replace(/^\/+/, "");
    if (!path) return err("path is required");
    const p = await d.progressForSpace(ctx.spaceId, path);
    const topics = Object.entries(p.topics);
    if (topics.length === 0) return ok(`No attempts recorded for ${path} yet (sidecar: ${progressSidecarPath(path)}).`);
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const lines = topics.map(([t, v]) => `- ${t}: best ${pct(v.best)}, last ${pct(v.last)}, ${v.attempts.length} attempt${v.attempts.length === 1 ? "" : "s"}`);
    const weak = weakTopics(p);
    return ok(`${path}\n${lines.join("\n")}\nWeak topics (last < 80%): ${weak.length ? weak.join(", ") : "none"}`);
  },
};
