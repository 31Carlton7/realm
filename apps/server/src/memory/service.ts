import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_MEMORY_CHANNEL, MEMORY_DOC_MAX, memorySupportNote,
  type AgentKind, type AgentsFileState, type Environment, type MemorySource, type MemorySources, type MemoryState,
} from "@realm/contracts";
import { RpcError } from "../store/rows";
import type { SettingsStore } from "../store/settings";
import { claudeMemoryFiles, claudeUserDir } from "./claude-files";

/** Per-space opt-in flag for the managed `AGENTS.md`. Off by default: it is a write into a folder. */
const agentsKey = (spaceId: string): string => `memory.agentsFile:${spaceId}`;

/**
 * The first line of every `AGENTS.md` Realm writes, and the ONLY kind it will ever rewrite or remove.
 * A user who deletes this line has taken the file over, and Realm treats it as theirs from then on.
 */
export const AGENTS_FILE_MARKER = "<!-- Managed by Realm.";
const AGENTS_FILE_HEADER =
  `${AGENTS_FILE_MARKER} Edit this space's memory in Realm instead — this file is rewritten whenever ` +
  "that document changes, and removed when the toggle is turned off. Deleting this comment makes the file yours. -->";

/** The one slice of EnvironmentsStore this service is allowed to see: where the space's own checkout
 *  is and — decisive for the write — what `kind` of directory it is. */
type PrimaryEnvironments = { ensurePrimary(spaceId: string): Environment };

const tryRead = (path: string): string | null => {
  try { return readFileSync(path, "utf8"); } catch { return null; }
};

/**
 * W3's memory manager: a per-space document Realm owns, injected into sessions per invocation, plus a
 * read-only model of what each agent actually loads.
 *
 * The document lives at `<realmHome>/memory/<spaceId>.md` — Realm's home, never any agent's config.
 * `~/.claude`, `~/.codex`, `~/.cursor` and `~/.agents` are strictly read-only to this class; the one
 * write it can make anywhere else is the marker-guarded `AGENTS.md` below, and only into a directory
 * whose environment row says Realm created it.
 */
export class MemoryService {
  /** Where user-level Claude files are read from. Overridable so tests and live checks never touch the
   *  real `~/.claude`; the default is the exact directory the CLI itself reads. */
  private readonly claudeDir: string;
  constructor(private d: { home: string; settings: SettingsStore; environments: PrimaryEnvironments; claudeDir?: string }) {
    this.claudeDir = d.claudeDir ?? claudeUserDir();
  }

  docPath(spaceId: string): string { return join(this.d.home, "memory", `${spaceId}.md`); }

  readDoc(spaceId: string): string { return tryRead(this.docPath(spaceId)) ?? ""; }

  state(spaceId: string): MemoryState {
    return { path: this.docPath(spaceId), doc: this.readDoc(spaceId), agentsFile: this.agentsFileState(spaceId) };
  }

  set(spaceId: string, doc: string): MemoryState {
    if (doc.length > MEMORY_DOC_MAX) throw new RpcError("MEMORY_DOC_TOO_LARGE", `the memory document is capped at ${MEMORY_DOC_MAX} characters`);
    mkdirSync(join(this.d.home, "memory"), { recursive: true });
    writeFileSync(this.docPath(spaceId), doc);
    // Keep the managed AGENTS.md in step — but never let its refusal fail the edit that mattered. A
    // file the user took over (marker deleted) stops being rewritten and says so in `agentsFile.reason`.
    if (this.agentsFileEnabled(spaceId)) {
      try { this.writeAgentsFile(this.d.environments.ensurePrimary(spaceId), doc); }
      catch (e) { console.error(`[memory] AGENTS.md for space ${spaceId} not rewritten: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return this.state(spaceId);
  }

  agentsFileEnabled(spaceId: string): boolean { return this.d.settings.get(agentsKey(spaceId)) === true; }

  setAgentsFile(spaceId: string, enabled: boolean): MemoryState {
    const env = this.d.environments.ensurePrimary(spaceId);
    if (enabled) {
      // Write first, record second: a toggle that cannot deliver its file must fail visibly rather
      // than persist a preference the folder refuses.
      this.writeAgentsFile(env, this.readDoc(spaceId));
      this.d.settings.set(agentsKey(spaceId), true);
    } else {
      this.d.settings.set(agentsKey(spaceId), false);
      this.removeAgentsFile(env);
    }
    return this.state(spaceId);
  }

  private agentsFilePath(env: Environment): string { return join(env.path, "AGENTS.md"); }

  /** Why Realm will not write `AGENTS.md` here, or null when it may. Shared by the state report and the
   *  write itself, so what the UI says and what the write does can never disagree. */
  private agentsFileBlocker(env: Environment): { code: string; message: string } | null {
    // The kind distinction is the whole guard: `primary` rows point at the folder SpacesStore.create
    // made fresh under Realm's home. A `checkout` is the user's own directory and a `worktree` is a
    // checkout of their repository — an AGENTS.md in either would pollute something Realm does not own.
    if (env.kind !== "primary") {
      return { code: "AGENTS_FILE_NOT_REALM_FOLDER", message: "Realm did not create this directory, so it will not write an AGENTS.md into it" };
    }
    const existing = tryRead(this.agentsFilePath(env));
    if (existing !== null && !existing.startsWith(AGENTS_FILE_MARKER)) {
      return { code: "AGENTS_FILE_FOREIGN", message: "an AGENTS.md Realm did not write is already in this folder; Realm will not overwrite it" };
    }
    return null;
  }

  /** The plan's ONE permitted write outside Realm's home. Marker-guarded and kind-guarded; throws rather
   *  than degrade, because a memory write that silently lands nowhere is the failure W3 exists to end. */
  private writeAgentsFile(env: Environment, doc: string): void {
    const blocked = this.agentsFileBlocker(env);
    if (blocked) throw new RpcError(blocked.code, blocked.message);
    writeFileSync(this.agentsFilePath(env), `${AGENTS_FILE_HEADER}\n\n${doc}`);
  }

  /** Removes the managed file — and ONLY the managed file. A foreign or user-adopted AGENTS.md stays. */
  private removeAgentsFile(env: Environment): void {
    const path = this.agentsFilePath(env);
    const existing = tryRead(path);
    if (existing !== null && existing.startsWith(AGENTS_FILE_MARKER)) rmSync(path);
  }

  private agentsFileState(spaceId: string): AgentsFileState {
    const env = this.d.environments.ensurePrimary(spaceId);
    const path = this.agentsFilePath(env);
    const existing = tryRead(path);
    const blocked = this.agentsFileBlocker(env);
    return {
      enabled: this.agentsFileEnabled(spaceId),
      path,
      exists: existing !== null,
      managedByRealm: existing !== null && existing.startsWith(AGENTS_FILE_MARKER),
      writable: blocked === null,
      reason: blocked?.message ?? null,
    };
  }

  /**
   * The per-session context for one agent start — `StartOptions.systemContext`, which the Claude
   * adapter appends to its system prompt and the Codex adapter sends as `developerInstructions`.
   *
   * Two ingredients, in load order:
   *
   * 1. **The W1 carry-forward.** A Claude session whose skills library is active runs with
   *    `settingSources: []`, which also stops the CLI loading `~/.claude/CLAUDE.md` and every project
   *    `CLAUDE.md`. Enabling a skill must not silently cost the user their own memory files, so their
   *    content rides back in here — the same files `claudeMemoryFiles` models for the pane, so what the
   *    UI lists as re-injected and what the session receives are one computation. Only when
   *    `skillsInjected` is true: otherwise the CLI loads these files itself and injecting them again
   *    would double every one of them.
   * 2. **This space's Realm memory document** — and only this space's; `spaceId` comes from the session
   *    row the caller is starting.
   *
   * Undefined for agents with no channel (`AGENT_MEMORY_CHANNEL` = "none"): Cursor's ACP session/new
   * takes `{cwd, mcpServers}` and nothing else, and handing an adapter context it can only drop would
   * make the memory pane a lie.
   */
  systemContextFor(o: { spaceId: string; kind: AgentKind; cwd: string; skillsInjected: boolean }): string | undefined {
    if (AGENT_MEMORY_CHANNEL[o.kind] === "none") return undefined;
    const parts: string[] = [];
    if (o.kind === "claude" && o.skillsInjected) {
      for (const f of claudeMemoryFiles(o.cwd, this.claudeDir)) {
        if (!f.content?.trim()) continue;
        parts.push(`Contents of ${f.path} (re-injected by Realm; this session loads no settings files itself because its skills library isolates them):\n\n${f.content}`);
      }
    }
    const doc = this.readDoc(o.spaceId).trim();
    if (doc) parts.push(`# Space memory\n\nThe user keeps this context for every session in this workspace (managed in Realm):\n\n${doc}`);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  /**
   * What durable context one session's agent loads, on the best authority available per agent:
   * Claude modeled from the paths the CLI reads, Codex from the `instructionSources` ITS OWN
   * `thread/start` reported (`reported` is null until it has), Cursor a stated nothing.
   */
  sourcesFor(o: { kind: AgentKind; spaceId: string; cwd: string; skillsInjected: boolean; reported: string[] | null }): MemorySources {
    const channel = AGENT_MEMORY_CHANNEL[o.kind];
    const note = memorySupportNote(o.kind);
    const realmMemoryInjected = channel !== "none" && this.readDoc(o.spaceId).trim().length > 0;
    if (o.kind === "claude") {
      const sources: MemorySource[] = claudeMemoryFiles(o.cwd, this.claudeDir).map((f) => ({
        path: f.path, origin: f.origin, exists: f.exists,
        via: !f.exists ? "none" : o.skillsInjected ? "realm" : "cli",
      }));
      return { agent: o.kind, channel, basis: "modeled", note, realmMemoryInjected, sources };
    }
    if (o.kind === "codex") {
      const sources: MemorySource[] = (o.reported ?? []).map((p) => ({ path: p, origin: "reported", exists: existsSync(p), via: "cli" }));
      // basis "none" until the session has started: an empty REPORT ("codex loaded zero files") and no
      // report yet are different facts, and the pane must not present the second as the first.
      return { agent: o.kind, channel, basis: o.reported === null ? "none" : "reported", note, realmMemoryInjected, sources };
    }
    return { agent: o.kind, channel, basis: "none", note, realmMemoryInjected, sources: [] };
  }
}
