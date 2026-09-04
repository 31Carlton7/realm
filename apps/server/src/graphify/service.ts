import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RpcError } from "../store/rows";
import { ProbeCache } from "../sessions/probe-cache";
import { graphifyBin, probeGraphify, type GraphifyProbe } from "./probe";

export type GraphifyResult = { code: number; stdout: string; stderr: string };
/** How this service invokes graphify — injectable so tests can assert the exact argv and cwd without
 *  graphify installed. The same seam, and the same reason, as `GitRun` in workspace/git-exec.ts. */
export type GraphifyRun = (cwd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<GraphifyResult>;

/** Extraction walks and parses every source file in the checkout, so this is a budget for a large
 *  repo, not for a shell command. It exists to bound a wedged child, not to police a slow one. */
export const GRAPHIFY_TIMEOUT_MS = 10 * 60_000;
/** Graph JSON for a big repo is megabytes of node-link data; graphify prints progress, not the graph,
 *  so this only ever has to hold log lines. Generous because a truncation kill would read as a crash. */
const GRAPHIFY_MAX_BYTES = 8 * 1024 * 1024;

/** Where `graphify update` writes, relative to the directory it ran in. */
const OUT_DIR = "graphify-out";

/**
 * Run one graphify command in `cwd` and report its exit code, stdout and stderr. Like `gitCapture`,
 * a non-zero exit RESOLVES: the caller has to read graphify's own complaint to tell the user what
 * went wrong. Only a failure to spawn at all (no binary on PATH) or a timeout kill rejects.
 *
 * Always execFile — `cwd` is a user-chosen checkout path and must never reach a shell string.
 */
export const graphifyCapture: GraphifyRun = (cwd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(graphifyBin(), args, { cwd, timeout: opts.timeoutMs ?? GRAPHIFY_TIMEOUT_MS, encoding: "utf8", maxBuffer: GRAPHIFY_MAX_BYTES },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        if (e && (e.code === "ENOENT" || e.killed)) { reject(e); return; }
        resolve({ code: typeof e?.code === "number" ? e.code : e ? 1 : 0, stdout, stderr });
      });
  });

export type GraphifySummary = { nodes: number; links: number; communities: number; graphPath: string };

/** First ~200 chars of whatever graphify said about its own failure — stderr preferred, stdout when
 *  the CLI wrote its complaint there instead, and the exit code when it said nothing at all. */
function graphifyReason(r: GraphifyResult): string {
  const said = r.stderr.trim() || r.stdout.trim();
  return said === "" ? `graphify exited ${r.code}` : said.slice(0, 200);
}

/**
 * Realm's seam onto the graphify CLI: is it installed, and re-extract a space's code graph.
 *
 * Deliberately NOT an agent. Graphify is a local extractor, not something that holds a conversation,
 * so it stays off `AgentKind` — widening that enum would put a tool with no models and no transcript
 * into the model picker and the session rows, which are `satisfies Record<AgentKind, …>`-checked
 * precisely so that cannot happen quietly.
 */
export class GraphifyService {
  private run: GraphifyRun;
  private probeCache: ProbeCache<GraphifyProbe>;

  constructor(private d: {
    run?: GraphifyRun;
    /** Overrides the binary the PROBE spawns (the `run` seam owns the binary for real invocations). */
    probeBin?: string;
    /** The space's primary checkout — `documents.rootForSpace` in app.ts. Injected rather than
     *  imported so this service never learns what a space, an environment or a database is. */
    rootForSpace: (spaceId: string) => string;
    now?: () => number;
  }) {
    this.run = d.run ?? graphifyCapture;
    // The same TTL + in-flight dedup + `force` escape hatch the agent probe gets, from the same
    // class: an install card asks on every mount, and "Check again" right after `uv tool install`
    // must not be answered from a cache filled before the installer finished.
    this.probeCache = new ProbeCache<GraphifyProbe>(() => probeGraphify(d.probeBin), { now: d.now });
  }

  probe(opts: { force?: boolean } = {}): Promise<GraphifyProbe> { return this.probeCache.get(opts); }

  /**
   * Re-extract the space's code graph in place and report what came out.
   *
   * `graphify update .` runs IN the checkout rather than being handed a path, so the path stays an
   * execFile cwd and never becomes an argument something could read as a flag. No LLM and no API key
   * are involved, so this is safe to offer for any space.
   *
   * `graphPath` is workspace-RELATIVE because the documents preview server addresses files relative
   * to the workspace root — an absolute path handed to it resolves to nothing.
   */
  async update(spaceId: string): Promise<GraphifySummary> {
    const root = this.d.rootForSpace(spaceId);
    let r: GraphifyResult;
    try {
      r = await this.run(root, ["update", "."], { timeoutMs: GRAPHIFY_TIMEOUT_MS });
    } catch (e) {
      // No binary on PATH, or a timeout kill. Not "graphify said no" — unusable tooling — but the
      // caller asked one question and deserves one answer with a code it can branch on.
      throw new RpcError("GRAPHIFY_FAILED", (e as Error).message.slice(0, 200));
    }
    if (r.code !== 0) throw new RpcError("GRAPHIFY_FAILED", graphifyReason(r));

    const graphJson = join(root, OUT_DIR, "graph.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(graphJson, "utf8"));
    } catch (e) {
      // A zero exit with no readable graph is still a failure: answering `{ nodes: 0, links: 0 }`
      // would draw an empty graph and call it a successful extraction.
      throw new RpcError("GRAPHIFY_FAILED", `graphify reported success but ${OUT_DIR}/graph.json is unreadable: ${(e as Error).message}`.slice(0, 200));
    }
    const g = parsed as { nodes?: unknown; links?: unknown } | null;
    // `links`, not `edges`. Graphify writes networkx node-link JSON, whose edge array is `links`;
    // reading `edges` finds nothing and reports a graph with no relationships as a success.
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.links)) {
      throw new RpcError("GRAPHIFY_FAILED", `graphify reported success but ${OUT_DIR}/graph.json is not node-link JSON (expected \`nodes\` and \`links\` arrays)`);
    }
    const communities = new Set<unknown>();
    for (const n of g.nodes) {
      const c = (n as { community?: unknown } | null)?.community;
      // Communities are a partition, so the count is of DISTINCT labels, not of nodes carrying one.
      // A node without a label joins no community rather than inventing one.
      if (c !== undefined && c !== null) communities.add(c);
    }
    return { nodes: g.nodes.length, links: g.links.length, communities: communities.size, graphPath: `${OUT_DIR}/graph.html` };
  }
}
