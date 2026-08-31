import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Environment, EnvironmentKind } from "@realm/contracts";
import { openDatabase } from "../db/database";
import { SettingsStore } from "../store/settings";
import { RpcError } from "../store/rows";
import { AGENTS_FILE_MARKER, MemoryService } from "./service";

const SPACE_A = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const SPACE_B = "01ARZ3NDEKTSV4RRFFQ69G5FAB";

/**
 * A stand-in for EnvironmentsStore that can claim any `kind` for a space's primary row — which the real
 * store never would, and which is exactly why the service's own kind guard has to hold: it is the last
 * line between the AGENTS.md write and a directory the user made.
 */
const envs = (bySpace: Record<string, { path: string; kind: EnvironmentKind }>) => ({
  ensurePrimary(spaceId: string): Environment {
    const e = bySpace[spaceId];
    if (!e) throw new Error(`no environment stubbed for ${spaceId}`);
    return { id: `env-${spaceId}`, spaceId, path: e.path, branch: null, kind: e.kind, portBlockStart: null, createdAt: 0, updatedAt: 0 };
  },
});

function harness(kinds: Partial<Record<string, EnvironmentKind>> = {}) {
  const home = mkdtempSync(join(tmpdir(), "realm-memory-"));
  const claudeDir = join(home, "claude-home");
  const folders: Record<string, { path: string; kind: EnvironmentKind }> = {};
  for (const [i, space] of [SPACE_A, SPACE_B].entries()) {
    const path = join(home, `space-${i}`);
    mkdirSync(path, { recursive: true });
    folders[space] = { path, kind: kinds[space] ?? "primary" };
  }
  const settings = new SettingsStore(openDatabase(join(home, "realm.db")));
  const memory = new MemoryService({ home, settings, environments: envs(folders), claudeDir });
  return { home, claudeDir, memory, settings, folderOf: (s: string) => folders[s]!.path };
}

describe("MemoryService documents", () => {
  it("round-trips the doc and reports its path under Realm's home", () => {
    const { home, memory } = harness();
    expect(memory.state(SPACE_A)).toMatchObject({ doc: "", path: join(home, "memory", `${SPACE_A}.md`) });
    const state = memory.set(SPACE_A, "remember the deploy steps");
    expect(state.doc).toBe("remember the deploy steps");
    expect(readFileSync(join(home, "memory", `${SPACE_A}.md`), "utf8")).toBe("remember the deploy steps");
  });

  it("keeps spaces apart: writing one space's doc never shows up in another's", () => {
    const { memory } = harness();
    memory.set(SPACE_A, "space A memory");
    memory.set(SPACE_B, "space B memory");
    expect(memory.state(SPACE_A).doc).toBe("space A memory");
    expect(memory.state(SPACE_B).doc).toBe("space B memory");
  });

  it("refuses a doc over the cap instead of writing an unbounded prompt", () => {
    const { memory } = harness();
    expect(() => memory.set(SPACE_A, "x".repeat(100_001))).toThrow(RpcError);
    expect(memory.state(SPACE_A).doc).toBe("");
  });
});

describe("MemoryService systemContextFor", () => {
  it("injects THIS space's doc, not another's", () => {
    const { memory } = harness();
    memory.set(SPACE_A, "space A memory");
    memory.set(SPACE_B, "space B memory");
    const ctx = memory.systemContextFor({ spaceId: SPACE_A, kind: "codex", cwd: "/tmp", skillsInjected: false })!;
    expect(ctx).toContain("space A memory");
    expect(ctx).not.toContain("space B memory");
  });

  it("is undefined when there is nothing to inject", () => {
    const { memory } = harness();
    expect(memory.systemContextFor({ spaceId: SPACE_A, kind: "claude", cwd: "/tmp", skillsInjected: false })).toBeUndefined();
    memory.set(SPACE_A, "   \n  "); // whitespace is nothing
    expect(memory.systemContextFor({ spaceId: SPACE_A, kind: "claude", cwd: "/tmp", skillsInjected: false })).toBeUndefined();
  });

  it("is undefined for agents with no channel, whatever the doc says", () => {
    const { memory } = harness();
    memory.set(SPACE_A, "space A memory");
    for (const kind of ["acp:cursor", "acp:gemini", "fake"] as const) {
      expect(memory.systemContextFor({ spaceId: SPACE_A, kind, cwd: "/tmp", skillsInjected: false })).toBeUndefined();
    }
  });

  it("re-injects the CLAUDE.md hierarchy for a Claude session running under settingSources: [] (the W1 carry-forward)", () => {
    const { memory, claudeDir, folderOf } = harness();
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.md"), "USER_MEMORY_MARKER_9317 plus @extra.md");
    writeFileSync(join(claudeDir, "extra.md"), "IMPORTED_MEMORY_MARKER_4482");
    const cwd = folderOf(SPACE_A);
    writeFileSync(join(cwd, "CLAUDE.md"), "PROJECT_MEMORY_MARKER_5561");

    const ctx = memory.systemContextFor({ spaceId: SPACE_A, kind: "claude", cwd, skillsInjected: true })!;
    // Losing any one of these silently is the failure this channel exists to prevent.
    expect(ctx).toContain("USER_MEMORY_MARKER_9317");
    expect(ctx).toContain("IMPORTED_MEMORY_MARKER_4482");
    expect(ctx).toContain("PROJECT_MEMORY_MARKER_5561");
    expect(ctx).toContain(join(claudeDir, "CLAUDE.md")); // each block names its file
  });

  it("does NOT re-inject when skills are off: the CLI loads those files itself and doubling them is the other bug", () => {
    const { memory, claudeDir, folderOf } = harness();
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.md"), "USER_MEMORY_MARKER_9317");
    memory.set(SPACE_A, "space A memory");
    const ctx = memory.systemContextFor({ spaceId: SPACE_A, kind: "claude", cwd: folderOf(SPACE_A), skillsInjected: false })!;
    expect(ctx).toContain("space A memory");
    expect(ctx).not.toContain("USER_MEMORY_MARKER_9317");
  });

  it("never re-injects CLAUDE.md into Codex — Codex loses nothing to the skills path", () => {
    const { memory, claudeDir, folderOf } = harness();
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.md"), "USER_MEMORY_MARKER_9317");
    memory.set(SPACE_A, "space A memory");
    const ctx = memory.systemContextFor({ spaceId: SPACE_A, kind: "codex", cwd: folderOf(SPACE_A), skillsInjected: true })!;
    expect(ctx).toContain("space A memory");
    expect(ctx).not.toContain("USER_MEMORY_MARKER_9317");
  });
});

describe("MemoryService AGENTS.md", () => {
  it("writes the marker-headed file into the Realm-created space folder on enable, and removes it on disable", () => {
    const { memory, folderOf } = harness();
    memory.set(SPACE_A, "the space doc");
    const path = join(folderOf(SPACE_A), "AGENTS.md");
    const on = memory.setAgentsFile(SPACE_A, true);
    expect(on.agentsFile).toMatchObject({ enabled: true, exists: true, managedByRealm: true, path });
    const written = readFileSync(path, "utf8");
    expect(written.startsWith(AGENTS_FILE_MARKER)).toBe(true);
    expect(written).toContain("the space doc");

    const off = memory.setAgentsFile(SPACE_A, false);
    expect(off.agentsFile).toMatchObject({ enabled: false, exists: false });
    expect(existsSync(path)).toBe(false);
  });

  it("rewrites the managed file when the doc changes — and only while enabled", () => {
    const { memory, folderOf } = harness();
    const path = join(folderOf(SPACE_A), "AGENTS.md");
    memory.setAgentsFile(SPACE_A, true);
    memory.set(SPACE_A, "second version");
    expect(readFileSync(path, "utf8")).toContain("second version");
    memory.setAgentsFile(SPACE_A, false);
    memory.set(SPACE_A, "third version");
    expect(existsSync(path)).toBe(false);
  });

  it("REFUSES to write into a directory Realm did not create, whatever kind of row claims it", () => {
    for (const kind of ["checkout", "worktree"] as const) {
      const { memory, folderOf } = harness({ [SPACE_A]: kind });
      expect(() => memory.setAgentsFile(SPACE_A, true)).toThrow(/did not create/);
      expect(existsSync(join(folderOf(SPACE_A), "AGENTS.md"))).toBe(false);
      // ...and the state says so, before anyone tries.
      const state = memory.state(SPACE_A);
      expect(state.agentsFile.writable).toBe(false);
      expect(state.agentsFile.reason).toMatch(/did not create/);
      // The flag was not persisted either: a doc edit later must not sneak the write in.
      memory.set(SPACE_A, "later doc");
      expect(existsSync(join(folderOf(SPACE_A), "AGENTS.md"))).toBe(false);
    }
  });

  it("REFUSES to overwrite an AGENTS.md Realm did not write", () => {
    const { memory, folderOf } = harness();
    const path = join(folderOf(SPACE_A), "AGENTS.md");
    writeFileSync(path, "the user's own agents file");
    expect(() => memory.setAgentsFile(SPACE_A, true)).toThrow(/will not overwrite/);
    expect(readFileSync(path, "utf8")).toBe("the user's own agents file");
    expect(memory.state(SPACE_A).agentsFile).toMatchObject({ exists: true, managedByRealm: false, writable: false });
  });

  it("a user who deletes the marker takes the file over: no rewrite on doc change, no delete on disable", () => {
    const { memory, folderOf } = harness();
    const path = join(folderOf(SPACE_A), "AGENTS.md");
    memory.setAgentsFile(SPACE_A, true);
    writeFileSync(path, "mine now"); // marker gone
    const after = memory.set(SPACE_A, "new doc"); // must not throw, must not rewrite
    expect(readFileSync(path, "utf8")).toBe("mine now");
    expect(after.agentsFile).toMatchObject({ managedByRealm: false, writable: false });
    memory.setAgentsFile(SPACE_A, false);
    expect(readFileSync(path, "utf8")).toBe("mine now");
  });
});

describe("MemoryService sourcesFor", () => {
  it("claude: models the hierarchy, marking how each file reaches the session", () => {
    const { memory, claudeDir, folderOf } = harness();
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.md"), "user memory");
    const cwd = folderOf(SPACE_A);

    const viaCli = memory.sourcesFor({ kind: "claude", spaceId: SPACE_A, cwd, skillsInjected: false, reported: null });
    expect(viaCli).toMatchObject({ agent: "claude", channel: "systemPrompt", basis: "modeled" });
    expect(viaCli.sources.find((s) => s.path === join(claudeDir, "CLAUDE.md"))).toMatchObject({ origin: "user", exists: true, via: "cli" });
    expect(viaCli.sources.find((s) => s.path === join(cwd, "CLAUDE.md"))).toMatchObject({ exists: false, via: "none" });

    // Skills on: the CLI loads nothing; Realm carries it. The pane must say which is happening.
    const viaRealm = memory.sourcesFor({ kind: "claude", spaceId: SPACE_A, cwd, skillsInjected: true, reported: null });
    expect(viaRealm.sources.find((s) => s.path === join(claudeDir, "CLAUDE.md"))).toMatchObject({ via: "realm" });
  });

  it("codex: passes the session's own report through, and keeps 'no report yet' distinct from 'reported zero files'", () => {
    const { memory, folderOf } = harness();
    const real = join(folderOf(SPACE_A), "AGENTS.md");
    writeFileSync(real, "agents");
    const reported = memory.sourcesFor({ kind: "codex", spaceId: SPACE_A, cwd: "/tmp", skillsInjected: false, reported: [real, "/nowhere/AGENTS.md"] });
    expect(reported).toMatchObject({ agent: "codex", channel: "developerInstructions", basis: "reported" });
    expect(reported.sources).toEqual([
      { path: real, origin: "reported", exists: true, via: "cli" },
      { path: "/nowhere/AGENTS.md", origin: "reported", exists: false, via: "cli" },
    ]);
    const unstarted = memory.sourcesFor({ kind: "codex", spaceId: SPACE_A, cwd: "/tmp", skillsInjected: false, reported: null });
    expect(unstarted).toMatchObject({ basis: "none", sources: [] });
    const empty = memory.sourcesFor({ kind: "codex", spaceId: SPACE_A, cwd: "/tmp", skillsInjected: false, reported: [] });
    expect(empty).toMatchObject({ basis: "reported", sources: [] });
  });

  it("cursor: a stated nothing — no channel, no sources, no realm memory, and a note naming the agent", () => {
    const { memory } = harness();
    memory.set(SPACE_A, "space A memory");
    const r = memory.sourcesFor({ kind: "acp:cursor", spaceId: SPACE_A, cwd: "/tmp", skillsInjected: false, reported: null });
    expect(r).toMatchObject({ agent: "acp:cursor", channel: "none", basis: "none", realmMemoryInjected: false, sources: [] });
    expect(r.note).toContain("Cursor");
  });

  it("realmMemoryInjected tracks the doc of THE space asked about", () => {
    const { memory } = harness();
    memory.set(SPACE_A, "space A memory");
    expect(memory.sourcesFor({ kind: "codex", spaceId: SPACE_A, cwd: "/tmp", skillsInjected: false, reported: null }).realmMemoryInjected).toBe(true);
    expect(memory.sourcesFor({ kind: "codex", spaceId: SPACE_B, cwd: "/tmp", skillsInjected: false, reported: null }).realmMemoryInjected).toBe(false);
  });
});
