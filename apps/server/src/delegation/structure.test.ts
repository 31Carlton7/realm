import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The structural half of Plan 13 W1's "extract, don't fork" rule — the same grep discipline
 * scoping.test.ts uses, for the same reason: the type system cannot stop someone pasting a second
 * copy of the settle loop into one tool "for now". The cancelled-wins ordering in that loop was a
 * live-found bug once; a fork is how it comes back in exactly one of the two tools.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "fixtures") out.push(...sourceFiles(p)); continue; }
    if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith("test-utils.ts")) out.push(p);
  }
  return out;
}

/** Files (relative to src/) whose CODE mentions `needle`. */
function filesMentioning(needle: string): string[] {
  return sourceFiles(SRC)
    .filter((p) => readFileSync(p, "utf8").includes(needle))
    .map((p) => relative(SRC, p))
    .sort();
}

describe("one settle/drain implementation (Plan 13 W1)", () => {
  // The drain loop's two distinctive lines: the settle condition and the cancelled-wins return.
  // Either one appearing in a second source file means the engine was forked.
  it.each([
    ["the settle condition", 'lastStatus === "idle" && finalText !== null'],
    ["the cancelled-wins return", 'if (run.cancelled) return { outcome: "interrupted"'],
    ["the run registry", "new Map<string, ActiveRun[]>"],
  ])("%s lives only in the engine", (_what, needle) => {
    expect(filesMentioning(needle)).toEqual(["delegation/engine.ts"]);
  });

  it("the interjection wait is the engine's too — ask.ts never grows a poll loop of its own", () => {
    const text = readFileSync(join(SRC, "delegation/ask.ts"), "utf8");
    expect(text).toMatch(/from "\.\/engine"/);
    expect(text).toContain("engine.awaitAnswer(");
    // The exact fork this file exists to prevent, in its Plan 20 form: a private sleep-and-re-read
    // inside the ask service, which is how the two waits drift apart.
    expect(text).not.toContain("setTimeout");
  });

  it("ask.ts targets an EXISTING session — it can never spawn or place one", () => {
    const text = readFileSync(join(SRC, "delegation/ask.ts"), "utf8");
    // Scope creep here turns "ask a peer" into a second, weaker agent_run. A peer is not a child:
    // the service may not create one, and may not reach for an environment to put one in.
    expect(text).not.toContain("sessions.create");
    expect(text).not.toContain("environments");
  });

  it("all three delegation flows consume the ONE engine rather than rolling their own wait", () => {
    for (const tool of ["browsers/browser-agent.ts", "delegation/agent-run.ts", "delegation/review.ts"]) {
      const text = readFileSync(join(SRC, tool), "utf8");
      expect(text).toMatch(/from "\.\.?\/(delegation\/)?engine"/);
      // `agent_run` reaches drain through the engine's `watch` (its blocking path is the detached
      // path plus an await) rather than calling it directly — still the one loop, one caller further
      // out. Every other flow calls drain itself.
      expect(text).toMatch(/engine\.(drain|watch)\(/);
      // No private polling loop: the tools never sleep-and-re-read session events themselves. This is
      // what keeps `agent_wait`'s listening budget in the engine (`awaitRuns`) where drain's is.
      expect(text).not.toContain("setTimeout");
    }
  });

  /**
   * Plan 24's own single-copy rule. Parallel delegation added a second way to be waiting on a child
   * (`awaitRuns`, the listening budget) and a second registry predicate (`atCapacity`); both belong to
   * the engine for drain's reason. A tool that grew its own `run.done` poll would be a third settle
   * path, and the one that silently stops honouring cancellation.
   */
  it("the detached-run bookkeeping is the engine's — no tool polls run.done itself", () => {
    expect(filesMentioning("async awaitRuns(")).toEqual(["delegation/engine.ts"]);
    expect(filesMentioning("run.done = s")).toEqual(["delegation/engine.ts"]);
    const text = readFileSync(join(SRC, "delegation/agent-run.ts"), "utf8");
    // It may READ done (to partition collected from still-running) but must never wait on it.
    expect(text).toContain("engine.awaitRuns(");
    expect(text).not.toMatch(/while\s*\(/);
    expect(text).not.toMatch(/for\s*\(;;\)/);
  });
});

/**
 * The dispatch recipe is extracted, not forked — the same rule the engine gets, for the same reason.
 * `agent_run` and durable runs both resolve "an existing environment XOR a fresh worktree, cleaned up
 * if the session then fails to exist"; two copies is how exactly one of them starts leaking orphan
 * worktrees the day someone fixes a bug in the other.
 */
describe("one dispatch recipe (durable runs)", () => {
  it.each([
    ["the mutual-exclusion refusal", "constraints.environmentId and constraints.newWorktree are mutually exclusive"],
    ["the skills-subset refusal", "must be a subset of this space's enabled skills"],
  ])("%s is worded in exactly one place", (_what, needle) => {
    // runs/service.ts re-raises the mutual-exclusion refusal at create time (before any dispatch),
    // so the words may appear there too — but never a third time, and never in agent-run.
    const files = filesMentioning(needle);
    expect(files).not.toContain("delegation/agent-run.ts");
    expect(files.filter((f) => f !== "runs/service.ts")).toEqual(["delegation/dispatch.ts"]);
  });

  it("both dispatchers consume the shared resolvers rather than resolving environments themselves", () => {
    for (const f of ["delegation/agent-run.ts", "runs/service.ts"]) {
      const text = readFileSync(join(SRC, f), "utf8");
      expect(text).toMatch(/from "\.\.?\/(delegation\/)?dispatch"/);
      expect(text).toContain("resolveEnvironment(");
      // Nobody creates a worktree behind the resolver's back.
      expect(text).not.toContain("createWorktree(");
    }
  });
});

/**
 * A durable run's settle must ride the persisted session-event rail, not a poll. A polling loop is a
 * second source of truth that a restart silently loses — precisely the failure a durable run exists
 * to not have — and it would also be a fork of the engine's drain by another name.
 */
describe("durable runs do not poll", () => {
  it("the run service has no timer and no drain of its own", () => {
    const text = readFileSync(join(SRC, "runs/service.ts"), "utf8");
    expect(text).not.toContain("setTimeout");
    expect(text).not.toContain("setInterval");
    expect(text).not.toContain("engine.drain(");
    // It settles off the SessionService hook the notifications feed uses.
    expect(text).toContain("handleSessionEvent(");
  });
});

/**
 * Plan 13 W3's BAN, enforced structurally: nothing wires review→ship. The review module must be
 * INCAPABLE of committing — it never imports git-write (or any workspace write surface), and no
 * other module reaches git-write off a review result: `workspace/git-write` has exactly two source
 * importers, the RPC layer (where the HUMAN's ship click arrives) and app.ts (which constructs it
 * for that layer). A third importer appearing — or the review module mentioning ship at all — means
 * someone built the auto-merge this plan forbids.
 */
describe("review→ship does not exist (Plan 13 W3)", () => {
  it("the review module never imports git-write and never calls a ship", () => {
    const text = readFileSync(join(SRC, "delegation/review.ts"), "utf8");
    // Import-level, because the doctrine COMMENTS rightly name the ban: what must be absent is the
    // capability, not the words. No git-write import, no GitWriteService type, no `.ship(` call.
    expect(text).not.toMatch(/from "[^"]*git-write"/);
    expect(text).not.toContain("GitWriteService");
    expect(text).not.toMatch(/\.ship\(/);
  });

  it("git-write's only source importers are the RPC layer and app.ts — the human's click, nowhere else", () => {
    expect(filesMentioning('from "../workspace/git-write"').concat(filesMentioning('from "./workspace/git-write"')).sort())
      .toEqual(["app.ts", "rpc/methods.ts"]);
  });
});
