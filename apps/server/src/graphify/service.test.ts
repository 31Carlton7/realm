import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { RpcError } from "../store/rows";
import { GraphifyService, type GraphifyRun } from "./service";

const SPACE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

let root: string;
beforeEach(() => { root = tempDir("realm-graphify-"); });

/** The node-link JSON graphify writes: `links`, not `edges`, and a `community` number per node. */
const writeGraph = (graph: unknown, at = root): void => {
  mkdirSync(join(at, "graphify-out"), { recursive: true });
  writeFileSync(join(at, "graphify-out", "graph.json"), JSON.stringify(graph));
};
const nodeLink = (communities: (number | null)[], links: number) => ({
  directed: true, multigraph: false, graph: {},
  nodes: communities.map((c, i) => (c === null ? { id: `n${i}` } : { id: `n${i}`, community: c })),
  links: Array.from({ length: links }, (_, i) => ({ source: "n0", target: `n${i}` })),
  hyperedges: [],
});

/** Records every invocation so the argv and cwd are assertable, and never spawns anything: these
 *  tests must pass on a machine where graphify was never installed. */
const fakeRun = (result: { code?: number; stdout?: string; stderr?: string } = {}) => {
  const calls: { cwd: string; args: string[] }[] = [];
  const run: GraphifyRun = async (cwd, args) => {
    calls.push({ cwd, args });
    return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { run, calls };
};

const service = (run: GraphifyRun) => new GraphifyService({ run, rootForSpace: () => root });

describe("GraphifyService.update", () => {
  it("runs `graphify update .` with the space's checkout as the cwd", async () => {
    // Two named mutants at once: passing the root as an ARGUMENT (a user path that would then have
    // to survive argv quoting) instead of as the cwd, and running any subcommand but `update`.
    const f = fakeRun();
    writeGraph(nodeLink([0], 0));
    await service(f.run).update(SPACE);
    expect(f.calls).toEqual([{ cwd: root, args: ["update", "."] }]);
  });

  it("counts nodes and links off the node-link JSON", async () => {
    // The named mutant reads `edges`, which is absent from graphify's node-link JSON, so every graph
    // would silently report 0 relationships while still succeeding.
    writeGraph(nodeLink([0, 1, 2], 7));
    expect(await service(fakeRun().run).update(SPACE)).toMatchObject({ nodes: 3, links: 7 });
  });

  it("counts DISTINCT communities, not nodes carrying one", async () => {
    // The named mutant counts nodes with a community (3) or the raw array length instead of the set
    // size, turning a two-community graph into a three-community one.
    writeGraph(nodeLink([0, 0, 1], 2));
    expect((await service(fakeRun().run).update(SPACE)).communities).toBe(2);
  });

  it("leaves a node with no community out of the count rather than inventing one", async () => {
    // The named mutant adds `undefined` to the set, so an unclustered node becomes its own community.
    writeGraph(nodeLink([0, null, null], 1));
    expect((await service(fakeRun().run).update(SPACE)).communities).toBe(1);
  });

  it("answers a workspace-RELATIVE path to the rendered graph", async () => {
    // The named mutant joins the root in, producing an absolute path the documents preview server
    // (which addresses files relative to the workspace root) resolves to nothing.
    writeGraph(nodeLink([0], 0));
    const r = await service(fakeRun().run).update(SPACE);
    expect(r.graphPath).toBe("graphify-out/graph.html");
    expect(r.graphPath.startsWith("/")).toBe(false);
  });

  it("throws GRAPHIFY_FAILED carrying graphify's own complaint on a non-zero exit", async () => {
    // The named mutant ignores the exit code and falls through to read a stale graph.json from a
    // previous run, reporting a failed extraction as a successful one.
    writeGraph(nodeLink([0, 1], 4));
    const f = fakeRun({ code: 2, stderr: "error: no supported source files found" });
    await expect(service(f.run).update(SPACE)).rejects.toMatchObject({
      code: "GRAPHIFY_FAILED", message: "error: no supported source files found",
    });
  });

  it("falls back to stdout for the reason when a failing graphify said nothing on stderr", async () => {
    const f = fakeRun({ code: 1, stdout: "Traceback (most recent call last)", stderr: "   " });
    await expect(service(f.run).update(SPACE)).rejects.toMatchObject({ message: "Traceback (most recent call last)" });
  });

  it("caps the reason so a megabyte of traceback never becomes an RPC error message", async () => {
    const f = fakeRun({ code: 1, stderr: "x".repeat(5000) });
    await expect(service(f.run).update(SPACE)).rejects.toMatchObject({ message: "x".repeat(200) });
  });

  it("throws rather than reporting zeros when a zero exit left no graph.json", async () => {
    // The named mutant defaults a missing/unparseable file to an empty graph, which draws an empty
    // graph pane and calls the extraction a success.
    const p = service(fakeRun().run).update(SPACE);
    await expect(p).rejects.toBeInstanceOf(RpcError);
    await expect(p).rejects.toMatchObject({ code: "GRAPHIFY_FAILED" });
  });

  it("throws when graph.json exists but is not parseable JSON", async () => {
    mkdirSync(join(root, "graphify-out"), { recursive: true });
    writeFileSync(join(root, "graphify-out", "graph.json"), "{not json");
    await expect(service(fakeRun().run).update(SPACE)).rejects.toMatchObject({ code: "GRAPHIFY_FAILED" });
  });

  it("throws when the JSON parses but carries no node-link arrays", async () => {
    // The named mutant reads `.length` off whatever is there, so `{}` answers NaN counts.
    writeGraph({ nodes: "lots", links: null });
    await expect(service(fakeRun().run).update(SPACE)).rejects.toMatchObject({ code: "GRAPHIFY_FAILED" });
  });

  it("turns a missing graphify binary into GRAPHIFY_FAILED, not an unhandled spawn error", async () => {
    // `graphifyCapture` rejects (rather than resolves) when there is nothing to spawn; the named
    // mutant lets that escape as an INTERNAL error with no code the client can branch on.
    const run: GraphifyRun = async () => { throw Object.assign(new Error("spawn graphify ENOENT"), { code: "ENOENT" }); };
    await expect(service(run).update(SPACE)).rejects.toMatchObject({ code: "GRAPHIFY_FAILED", message: "spawn graphify ENOENT" });
  });
});

describe("GraphifyService.probe", () => {
  it("answers a second unforced call from the cache, and re-probes when forced", async () => {
    // The named mutant drops the ProbeCache and probes on every call, spawning a child process per
    // install-card mount; the inverse mutant caches `force: true` too, so "Check again" right after
    // `uv tool install "graphifyy[mcp]"` keeps answering the pre-install truth.
    // Object identity is the proof: `probeGraphify` builds a fresh object per run, so a shared
    // reference can only have come from the cache.
    const svc = new GraphifyService({ run: fakeRun().run, probeBin: "/definitely/not/a/binary", rootForSpace: () => root });
    const first = await svc.probe();
    expect(first.available).toBe(false);
    expect(await svc.probe()).toBe(first);
    const forced = await svc.probe({ force: true });
    expect(forced).not.toBe(first);
    expect(forced).toEqual(first);
  });
});
