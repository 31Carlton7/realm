import { z } from "zod";
import { AGENT_META } from "./presets";
import { AgentKindSchema, type AgentKind } from "./entities";

/**
 * W3's ground rule: Realm READS the files each agent loads and never writes them. The one permitted
 * write is the opt-in `AGENTS.md` in a space folder Realm itself created (`AgentsFileState`), and even
 * that is refused anywhere else. Everything else reaches a session through a per-session parameter —
 * `systemPrompt.append` for Claude, `thread/start` `developerInstructions` for Codex — or not at all.
 */

/** Hard cap on ONE Realm memory document (space or profile). It travels inside every session's system
 *  context, so an unbounded doc is a prompt that quietly swallows the context window. */
export const MEMORY_DOC_MAX = 100_000;

/**
 * W2: cap on the COMBINED memory content injected into one session (profile doc + space doc), enforced
 * where the CLIs actually meet the docs — `MemoryService.systemContextFor`. Each doc is write-capped at
 * `MEMORY_DOC_MAX`, so two full docs could otherwise double the old injection budget. When the pair
 * exceeds this, the PROFILE doc is truncated to fit and the space doc rides whole: the space doc is the
 * more specific standing instruction for the workspace the session is actually in.
 */
export const MEMORY_COMBINED_MAX = 150_000;

/**
 * The profile-level memory doc as one space sees it (W2). `enabledHere` is the per-space inheritance
 * toggle — the profile doc is an inherited item like any other: ON by default, per-space disableable,
 * never editable from a space (`memory.setProfile` edits it at its defining scope).
 */
export const ProfileMemoryStateSchema = z.object({
  profileId: z.string(),
  /** Where the profile document lives: `<realmHome>/memory/profile-<profileId>.md`. */
  path: z.string(),
  doc: z.string(),
  /** Whether THIS space injects the profile doc. Per-space, default true. */
  enabledHere: z.boolean(),
});
export type ProfileMemoryState = z.infer<typeof ProfileMemoryStateSchema>;

/**
 * One file of durable context, as `memory.sources` reports it for a session.
 *
 * `via` is the honest part: `cli` means the agent loads the file itself, `realm` means Realm carries
 * its content into the session (a Claude session whose skills library sets `settingSources: []` loads
 * NO settings files on its own — Realm re-injects them), and `none` means the file is a known location
 * that is currently empty or absent.
 */
export const MemorySourceSchema = z.object({
  /** Absolute path. */
  path: z.string(),
  /** `user` = the agent's home-dir file, `project` = a checkout-level file, `import` = pulled in by an
   *  `@path` reference, `reported` = named by the agent itself (Codex `instructionSources`). */
  origin: z.enum(["user", "project", "import", "reported"]),
  exists: z.boolean(),
  /** How the content reaches the session: loaded by the CLI itself, re-injected by Realm, or not at all. */
  via: z.enum(["cli", "realm", "none"]),
});
export type MemorySource = z.infer<typeof MemorySourceSchema>;

/**
 * The opt-in `AGENTS.md` at the root of a Realm-created space folder — the plan's one permitted write.
 *
 * `writable: false` (with `reason`) covers the two refusals: the space's primary checkout is a
 * directory Realm did not create, or an `AGENTS.md` Realm did not write already sits there.
 */
export const AgentsFileStateSchema = z.object({
  enabled: z.boolean(),
  /** Where the file goes (or is): `<space folder>/AGENTS.md`. */
  path: z.string(),
  exists: z.boolean(),
  /** True when the file on disk carries Realm's marker header — the only kind Realm will rewrite or remove. */
  managedByRealm: z.boolean(),
  writable: z.boolean(),
  reason: z.string().nullable(),
});
export type AgentsFileState = z.infer<typeof AgentsFileStateSchema>;

/** A space's Realm-owned memory document, stored under Realm's home — never in any agent's config. */
export const MemoryStateSchema = z.object({
  /** Where the document lives: `<realmHome>/memory/<spaceId>.md`. */
  path: z.string(),
  doc: z.string(),
  agentsFile: AgentsFileStateSchema,
  /** The profile doc this space inherits (W2), or null when the space's profile is unknown. Injection
   *  order is profile doc then space doc, combined cap `MEMORY_COMBINED_MAX`. */
  profile: ProfileMemoryStateSchema.nullable(),
});
export type MemoryState = z.infer<typeof MemoryStateSchema>;

/**
 * The per-session channel Realm can hand durable context through, per agent — proven live, not assumed
 * (see `docs/superpowers/specs/2026-08-29-agent-config-surfaces.md` §1.3).
 *
 * - `systemPrompt` — Claude: `systemPrompt: { type: "preset", preset: "claude_code", append }`.
 * - `developerInstructions` — Codex: a `thread/start` parameter.
 * - `none` — ACP `session/new` is `{cwd, mcpServers}`: there is no parameter to put context in, so
 *   nothing Realm manages reaches these agents. Stated, not faked: no adapter fallback pretends otherwise.
 */
export type MemoryChannel = "systemPrompt" | "developerInstructions" | "none";
export const AGENT_MEMORY_CHANNEL = {
  claude: "systemPrompt",
  codex: "developerInstructions",
  "acp:cursor": "none",
  "acp:gemini": "none",
  "acp:opencode": "none",
  "acp:copilot": "none",
  "acp:goose": "none",
  "acp:qwen": "none",
  "acp:grok": "none",
  "acp:fx": "none",
  "acp:deepseek": "none",
  "acp:openhands": "none",
  // Hermes carries a great deal of durable context of its own — memory, skills, a user model — and
  // none of it is Realm's, which is exactly what this table means by `none`.
  "acp:hermes": "none",
  fake: "none",
} as const satisfies Record<AgentKind, MemoryChannel>;

/**
 * What `memory.sources` answers for one session: which durable-context files reach its agent, and on
 * what authority.
 *
 * `basis` names the authority so the UI can say it: `modeled` — Realm read the same paths the CLI
 * reads (Claude); `reported` — the agent itself named the files it loaded (Codex `instructionSources`);
 * `none` — either the agent takes no durable context at all (Cursor) or it has not started yet and so
 * has reported nothing (a Codex session before its first message).
 */
export const MemorySourcesSchema = z.object({
  agent: AgentKindSchema,
  channel: z.enum(["systemPrompt", "developerInstructions", "none"]),
  basis: z.enum(["modeled", "reported", "none"]),
  /** One sentence naming the agent and its reality, so a note rendered for the wrong session is visibly wrong. */
  note: z.string(),
  /** Whether this space's Realm memory document is non-empty and travels to this agent's sessions. */
  realmMemoryInjected: z.boolean(),
  /** Whether the memory repo's `MEMORY.md` travels into this agent's sessions. False for an agent with
   *  no context channel even where the space has a repo: those reach it through the memory tools. */
  repoIndexInjected: z.boolean(),
  sources: z.array(MemorySourceSchema),
});
export type MemorySources = z.infer<typeof MemorySourcesSchema>;

/** The per-agent honesty line for the memory pane. Always names the agent. */
export function memorySupportNote(kind: AgentKind): string {
  const label = AGENT_META[kind].label;
  switch (AGENT_MEMORY_CHANNEL[kind]) {
    case "systemPrompt":
      return `${label} sessions receive this space's Realm memory per session; the files below are the ones the CLI reads, modeled by Realm from the same paths.`;
    case "developerInstructions":
      return `${label} sessions receive this space's Realm memory per session, and ${label} itself reports the exact instruction files it loaded once the session starts.`;
    default:
      return `${label} takes no per-session context parameter, so neither Realm's memory documents nor any managed file reaches it; a memory repo, where one is attached, reaches it through Realm's memory tools.`;
  }
}

/*
 * ─── Memory repos ─────────────────────────────────────────────────────────────────────────────────
 *
 * The memory an AGENT writes, kept in its own git repository in the Agent Memory Repo format
 * (github.com/AgentMemoryRepo/agentmemoryrepo). The documents above stay the user's standing
 * instructions; a memory repo is what agents save facts into and read back across sessions, engines
 * and machines. Every rule of the format Realm implements lives in this block and nowhere else: the
 * spec is young, and a change to it should be a change to one file.
 */

/** The spec commit this block was written against. */
export const AMR_SPEC_COMMIT = "8798cb2";

/** The entry point every session loads (spec: "Agents load it at the start of every session"). */
export const MEMORY_REPO_INDEX_FILE = "MEMORY.md";

/** What a new repo's `MEMORY.md` starts as — the spec skill's own seed, byte for byte. */
export const MEMORY_REPO_INITIAL_INDEX = "# Memory\n\n## Index\n";

/** Cap on the `MEMORY.md` content injected into one session. The spec asks for a short file; a long one
 *  is cut here, with a pointer to `memory_read`, so it can never crowd the space's own document out. */
export const MEMORY_REPO_INDEX_MAX = 20_000;

/** Cap on one entry. An entry is one line of one fact, and a paragraph is a topic file. */
export const MEMORY_REPO_ENTRY_MAX = 2_000;

/**
 * A memory repo as one scope sees it. `scope`/`ownerId` say whose it is — a profile's, in this
 * release; per-space repos are the next one, which is why a space reads a LIST of these.
 *
 * `valid` is the spec's own test: `git rev-parse --show-toplevel` is the path itself and `MEMORY.md`
 * sits at the top. `reason` is why Realm will not write to it right now (not a repo, uncommitted
 * changes), or null when it will.
 */
export const MemoryRepoStateSchema = z.object({
  path: z.string(),
  scope: z.enum(["profile", "space"]),
  ownerId: z.string(),
  exists: z.boolean(),
  valid: z.boolean(),
  clean: z.boolean(),
  /** `git status --porcelain` paths, at most 20 — what the user has to commit or remove first. */
  uncommitted: z.array(z.string()),
  head: z.string().nullable(),
  lastCommitAt: z.number().nullable(),
  lastCommitSubject: z.string().nullable(),
  remote: z.string().nullable(),
  pushEnabled: z.boolean(),
  indexChars: z.number(),
  /** Whether the space asked about uses this repo; null when no space was asked about. */
  inheritedHere: z.boolean().nullable(),
  reason: z.string().nullable(),
});
export type MemoryRepoState = z.infer<typeof MemoryRepoStateSchema>;

/** One commit of a memory repo — what an agent remembered, and when. */
export const MemoryRepoCommitSchema = z.object({ sha: z.string(), subject: z.string(), at: z.number() });
export type MemoryRepoCommit = z.infer<typeof MemoryRepoCommitSchema>;

/** One entry: the fact, and its trailing `[key: value; key: value]` metadata. Keys are open. */
export type MemoryEntry = { text: string; meta: Record<string, string> };

const ENTRY_LINE = /^\s*[-*+]\s+(.*)$/;
const META_TAIL = /\s*\[([^[\]\n]*)\]$/;
const META_PAIR = /^([A-Za-z][\w-]*):\s+(.*)$/;
/** A pair boundary is a `;` followed by the next `key: `, so a `;` inside a URL stays in its value. */
const META_SPLIT = /;\s*(?=[A-Za-z][\w-]*:\s)/;

/**
 * Reads one bullet line as an entry, or null for a line that is not a bullet. A trailing bracket is
 * metadata only when every part of it is a `key: value` pair — `[see notes]` is part of the fact. The
 * `: ` (with its space) is what keeps `https://…` from reading as a key.
 */
export function parseMemoryEntry(line: string): MemoryEntry | null {
  const m = ENTRY_LINE.exec(line);
  if (!m) return null;
  const body = m[1]!.trimEnd();
  const tail = META_TAIL.exec(body);
  if (tail) {
    const meta: Record<string, string> = {};
    const pairs = tail[1]!.split(META_SPLIT).map((p) => META_PAIR.exec(p.trim()));
    if (pairs.length > 0 && pairs.every((p) => p !== null)) {
      for (const p of pairs) meta[p![1]!] = p![2]!.trim();
      return { text: body.slice(0, tail.index).trimEnd(), meta };
    }
  }
  return { text: body, meta: {} };
}

/** One entry as its bullet line. */
export function formatMemoryEntry(e: MemoryEntry): string {
  const pairs = Object.entries(e.meta).map(([k, v]) => `${k}: ${v}`);
  return `- ${e.text}${pairs.length > 0 ? ` [${pairs.join("; ")}]` : ""}`;
}

/**
 * Why an entry cannot be written, or null. The test that matters is the last one: an entry that
 * would not read back as itself — a fact that ends in something shaped like metadata, a value with a
 * bracket in it — is refused rather than saved as a different entry.
 */
export function memoryEntryProblem(e: MemoryEntry): string | null {
  if (e.text.trim() === "") return "the entry is empty";
  if (/[\r\n]/.test(e.text)) return "an entry is one line — put a longer note in a topic file with memory_write_file";
  if (formatMemoryEntry(e).length > MEMORY_REPO_ENTRY_MAX) return `an entry is capped at ${MEMORY_REPO_ENTRY_MAX} characters — put a longer note in a topic file`;
  for (const [k, v] of Object.entries(e.meta)) {
    if (!/^[A-Za-z][\w-]*$/.test(k)) return `"${k}" is not a metadata key (letters, digits, - and _)`;
    if (v.trim() === "" || /[[\]\r\n]/.test(v)) return `the "${k}" value must be one line with no square brackets`;
  }
  const back = parseMemoryEntry(formatMemoryEntry(e));
  if (!back || back.text !== e.text || JSON.stringify(back.meta) !== JSON.stringify(e.meta))
    return "the entry would not read back as written — it ends in something shaped like [key: value] metadata";
  return null;
}

/**
 * The file a cross-link points at, from the repo root: `[[projects/payments]]` is
 * `projects/payments.md`, and a name with an extension keeps it (`[[metrics/keep_rate.sql]]`). A bare
 * path is taken as the inside of a link, so a tool can accept either.
 */
export function wikiLinkTarget(link: string): string | null {
  const m = /^\[\[([^[\]]*)\]\]$/.exec(link.trim());
  const p = (m ? m[1]! : link).trim().replace(/^\/+/, "");
  if (p === "" || /[[\]]/.test(p)) return null;
  return /\.[A-Za-z0-9]+$/.test(p.split("/").at(-1)!) ? p : `${p}.md`;
}

/** The cross-link for a repo path: `.md` dropped, any other extension kept. */
export function wikiLinkFor(path: string): string {
  return `[[${path.replace(/\.md$/i, "")}]]`;
}

const INDEX_HEADING = /^##\s+Index\s*$/i;
const HEADING = /^#{1,6}\s/;

/** `MEMORY.md` with a link to `path` under `## Index` (the heading added if it is missing). A link
 *  already there anywhere in the file leaves it as it was. */
export function withIndexLink(index: string, path: string): string {
  const link = wikiLinkFor(path);
  if (index.includes(link)) return index;
  if (index.trim() === "") return `## Index\n- ${link}\n`;
  const lines = index.replace(/\n+$/, "").split("\n");
  const at = lines.findIndex((l) => INDEX_HEADING.test(l));
  if (at === -1) return `${lines.join("\n")}\n\n## Index\n- ${link}\n`;
  let end = at + 1;
  for (let i = at + 1; i < lines.length; i++) {
    if (HEADING.test(lines[i]!)) break;
    if (lines[i]!.trim() !== "") end = i + 1;
  }
  lines.splice(end, 0, `- ${link}`);
  return `${lines.join("\n")}\n`;
}

/** The `source` an agent's save is stamped with. AMR keys are open and Realm registers no URL scheme,
 *  so this names the session in Realm's own terms rather than pretending to be a link. */
export function amrRepoSourceLink(sessionId: string): string {
  return `realm:session/${sessionId}`;
}

export type MemoryEdit =
  | { op: "add"; entry: MemoryEntry }
  | { op: "replace"; match: string; entry: MemoryEntry }
  | { op: "remove"; match: string };

export type MemoryEditResult =
  | { ok: true; content: string; changed: boolean }
  | { ok: false; error: string };

/**
 * One edit to one Markdown file of a memory repo, as text in and text out — the spec's "edit in
 * place" rule, kept apart from git so it can be tested line by line.
 *
 * - `add` puts a fact in `MEMORY.md` ABOVE `## Index` (the spec's place for what every session
 *   needs) and at the end of any other file. A fact already there word for word is not added twice.
 * - `replace` and `remove` find the ONE entry whose text is `match` exactly, or failing that the one
 *   whose text contains it. None, or more than one, is an error that says which, so the agent can
 *   quote more rather than change the wrong line.
 */
export function applyMemoryEdit(content: string, edit: MemoryEdit, o: { isIndex: boolean; title: string }): MemoryEditResult {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  if (edit.op === "add") {
    if (lines.some((l) => parseMemoryEntry(l)?.text === edit.entry.text)) return { ok: true, content, changed: false };
    const line = formatMemoryEntry(edit.entry);
    if (lines.length === 0) return { ok: true, content: o.isIndex ? `${line}\n` : `# ${o.title}\n\n${line}\n`, changed: true };
    const at = o.isIndex ? lines.findIndex((l) => INDEX_HEADING.test(l)) : -1;
    if (at === -1) {
      while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
      // A heading wants a blank line under it; a run of bullets does not.
      if (lines.length > 0 && HEADING.test(lines.at(-1)!)) lines.push("");
      lines.push(line);
      return { ok: true, content: `${lines.join("\n")}\n`, changed: true };
    }
    let k = at;
    while (k > 0 && lines[k - 1]!.trim() === "") k--;
    const block = [line, ""];
    if (k > 0 && HEADING.test(lines[k - 1]!)) block.unshift("");
    lines.splice(k, at - k, ...block);
    return { ok: true, content: `${lines.join("\n")}\n`, changed: true };
  }
  const wanted = (parseMemoryEntry(edit.match)?.text ?? edit.match).trim();
  if (wanted === "") return { ok: false, error: "say which entry: give its text" };
  const entries = lines.map((l, i) => ({ i, e: parseMemoryEntry(l) })).filter((x) => x.e !== null);
  let hits = entries.filter((x) => x.e!.text === wanted);
  if (hits.length === 0) hits = entries.filter((x) => x.e!.text.toLowerCase().includes(wanted.toLowerCase()));
  if (hits.length === 0) return { ok: false, error: `no entry matches "${wanted}"` };
  if (hits.length > 1) return { ok: false, error: `${hits.length} entries match "${wanted}" — quote more of the one you mean:\n${hits.map((h) => lines[h.i]).join("\n")}` };
  const i = hits[0]!.i;
  if (edit.op === "remove") {
    lines.splice(i, 1);
    // The last fact of a run leaves the blank lines that framed it; keep one.
    if (i > 0 && lines[i - 1]?.trim() === "" && lines[i]?.trim() === "") lines.splice(i, 1);
  } else lines[i] = formatMemoryEntry(edit.entry);
  return { ok: true, content: lines.length > 0 ? `${lines.join("\n")}\n` : "", changed: true };
}
