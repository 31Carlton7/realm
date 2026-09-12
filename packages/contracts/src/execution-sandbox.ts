import { z } from "zod";

/**
 * What a spawned agent or shell is ALLOWED TO DO on this Mac — the policy half of Realm's execution
 * sandbox.
 *
 * **Not `sandbox.ts`.** That file is about dialling somebody else's VNC endpoint (E2B, Modal, a
 * second Mac) and shares nothing with this one but a word. Everything here is prefixed
 * `ExecutionSandbox*` / `EXECUTION_SANDBOX_*` so a grep for either concept only finds the one it
 * meant, and so an import of the wrong `SandboxProvider` cannot typecheck by accident.
 *
 * ## What this buys, stated exactly
 *
 * Realm's isolation up to now was a git worktree, a port block and a permission mode — all of them
 * conventions between Realm and a well-behaved agent. An agent CLI is a process with the user's uid,
 * so it can read `~/.ssh/id_ed25519`, write `~/Library/LaunchAgents`, and open Realm's own database.
 * This policy is enforced by the KERNEL instead, through macOS Seatbelt at the spawn boundary, and
 * it holds for every agent kind at once — including ACP agents Realm does not control, because
 * Realm spawns them.
 *
 * ## What it does NOT buy — read this before describing the feature to anyone
 *
 *  - **It is not a container.** No pid namespace, no separate filesystem, no user namespace. The
 *    sandboxed process shares the machine with everything else on it and can see every process id.
 *  - **The default posture allows network.** An agent CLI that cannot reach its own API is not an
 *    agent, so `workspace-write` leaves the network open. Anything the process can READ, it can send
 *    somewhere. This contains filesystem damage and secret-file reads; it does NOT contain
 *    exfiltration of what remains readable.
 *  - **Reads are broad by default.** `workspace-write` denies a named list of credential
 *    directories and leaves the rest of the disk readable, because a read allowlist that keeps
 *    node/git/pnpm working is most of the filesystem anyway. `readableRoots` exists for callers who
 *    want the stricter shape, and the honest cost is that they must enumerate the system roots.
 *  - **The agent's own state directory is writable.** It has to be — `claude` and `codex` do not
 *    start otherwise (see `AGENT_STATE_DIRS`). The executable configuration inside it is frozen, but
 *    the prompt-shaped files are not, so a sandboxed session can leave instructions a LATER session
 *    of the same CLI will read. Cross-session prompt injection is not covered.
 *  - **Seatbelt matches PATHS, not inodes.** A hard link that already exists at an allowed path,
 *    pointing at a file inside a denied one, reads fine. (Measured. Creating that link from inside
 *    the sandbox is itself refused, so this needs prior code execution outside it.)
 *  - **`sandbox-exec` is formally DEPRECATED by Apple** — its own man page says so — while remaining
 *    present and functional (macOS 27.0, verified). Realm uses it because it is the only per-spawn
 *    policy mechanism available to a non-App-Store process that does not require entitlements or a
 *    helper tool, and because it is what Codex CLI uses on macOS for the same reason. If a macOS
 *    release removes it, `sandbox.available` goes false and every posture except `off` refuses to
 *    start: see the fail-closed note on `ExecutionSandboxPosture`.
 */

/**
 * How much a session or terminal is allowed to touch. Three, because there are three genuinely
 * different answers and no fourth that is not one of these with extra words.
 *
 *  - `workspace-write` — the one to pick. Writes land in the checkout and in the toolchain caches a
 *    build genuinely needs; everything else on disk is read-only; a named list of credential
 *    directories is unreadable; network is allowed.
 *  - `read-only` — no writes anywhere except the process's own temp directory and `/dev/null`.
 *    For a session you want to think but not act. Network follows the same switch.
 *  - `off` — no Seatbelt at all, which is what every Realm release before this one did, and what
 *    this release still ships as the default. See `EXECUTION_SANDBOX_DEFAULT_POSTURE`.
 *
 * **`off` is the ONLY way to reach an unsandboxed spawn, and it is a stored, displayed choice.**
 * There is deliberately no fallback path that degrades to it: if `sandbox-exec` is missing, if the
 * policy will not compile, or if the platform is not macOS, a session under any other posture
 * REFUSES TO START rather than starting unprotected. Fail-open was considered and rejected — a
 * security feature that silently turns itself off is worse than none, because the user has been
 * told they have it. The cost of fail-closed is real and accepted: a Realm that cannot sandbox is a
 * Realm that cannot run agents until the user picks `off` on purpose.
 */
export const ExecutionSandboxPostureSchema = z.enum(["workspace-write", "read-only", "off"]);
export type ExecutionSandboxPosture = z.infer<typeof ExecutionSandboxPostureSchema>;

/**
 * What ships when nobody has chosen. **`off` — this release is OPT-IN.**
 *
 * `workspace-write` is the intended default and this line is meant to become it. It is not that
 * today for two reasons, both of which are about the posture a user did NOT choose:
 *
 *  1. **A wrong writable-root list breaks builds, and it does not look like a sandbox.** The roots
 *     are derived from this Mac (`TOOLCHAIN_CACHE_DIRS`, the space's checkouts, `$TMPDIR`), and the
 *     list is exactly as complete as whoever last edited it. A toolchain Realm has not heard of
 *     fails at `mkdir` inside somebody's build, and what the user sees is Realm being broken — on a
 *     first release, on a protection they never asked for. That is the worst possible introduction
 *     to this feature.
 *  2. **Codex cannot run sandboxed yet.** `CodexAdapter` refcounts ONE `codex app-server` process
 *     across every session, so one process cannot hold two spaces' policies; a Codex session under
 *     any posture but `off` refuses to start (see the limitation note in `codex-adapter.ts`). A
 *     default of `workspace-write` would therefore stop Codex working for everyone who upgraded,
 *     with no change on their part.
 *
 * So the shipped default changes nothing, and the sandbox is something a person turns on in
 * Settings and knows they turned on. Flip this to `workspace-write` once the root list has been
 * exercised on real machines AND the Codex limitation is fixed — not before, and not one without
 * the other.
 *
 * The cost, stated: a default of `off` means most users have no sandbox. That is a real loss, taken
 * deliberately, because a security feature that breaks builds gets switched off wholesale and never
 * switched back on.
 */
export const EXECUTION_SANDBOX_DEFAULT_POSTURE: ExecutionSandboxPosture = "off";

/**
 * The resolved thing a spawn is actually compiled from. Every path is ABSOLUTE and REAL — already
 * through `realpath`.
 *
 * That requirement is not pedantry, and it is the single most dangerous detail in this feature.
 * Seatbelt matches the path the kernel resolved, so a writable root of `/tmp/x` (a symlink; the real
 * path is `/private/tmp/x`) matches NOTHING — verified. For a writable root that fails closed and
 * merely looks like a broken sandbox. For a `protectedRoots` entry it fails OPEN: the deny matches
 * nothing and the secret stays readable. `resolveExecutionSandboxPolicy` on the server is the only
 * supported way to build one of these, and it resolves both ways round for exactly this reason.
 */
export const ExecutionSandboxPolicySchema = z.object({
  posture: ExecutionSandboxPostureSchema,
  /** Subtrees the process may write. The environment's checkout, the toolchain caches, its temp dir. */
  writableRoots: z.array(z.string()).default([]),
  /**
   * Subtrees the process may read. **Empty means "the whole filesystem"** — which is what
   * `workspace-write` uses. Non-empty flips reads to deny-by-default, and then this list is
   * exhaustive: it must include `/usr`, `/bin`, `/System`, the agent CLI's own install directory and
   * every dylib it loads, or the process will not even start. Realm ships no posture that does this;
   * the field is here so a caller who wants it does not have to fork the compiler.
   */
  readableRoots: z.array(z.string()).default([]),
  /**
   * Subtrees that may be READ but never WRITTEN, whatever `writableRoots` says.
   *
   * This exists for one specific shape of file: EXECUTABLE CONFIGURATION that the agent must be able
   * to read and must not be able to edit. `~/.claude/settings.json` declares hooks, `~/.gitconfig`
   * declares aliases and a pager, `~/.zshrc` runs on every login shell — and all three are read by
   * the toolchain constantly. Putting them in `protectedRoots` instead would deny the read and break
   * the CLI; leaving them out entirely would let a sandboxed agent arrange for a command to run the
   * next time the user opens a terminal OUTSIDE Realm, which is a complete escape one step removed.
   */
  readOnlyPaths: z.array(z.string()).default([]),
  /**
   * Subtrees that stay both UNREADABLE and UNWRITABLE whatever the two lists above say. Applied
   * last, and SBPL's last matching rule wins (verified), so these beat a blanket read allow, an
   * explicit `readableRoots` entry, and a `writableRoots` entry that happens to contain one of them
   * — which is the case that matters, because a space whose folder is `~` would otherwise make
   * `~/.ssh` writable while it was unreadable.
   */
  protectedRoots: z.array(z.string()).default([]),
  /** Outbound sockets, of every family. There is no half-open shape here: Seatbelt's per-host
   *  filtering does not work for a process that resolves DNS itself, so offering "allow api.x.com"
   *  would be a checkbox that does not mean what it says. */
  network: z.boolean().default(true),
});
export type ExecutionSandboxPolicy = z.infer<typeof ExecutionSandboxPolicySchema>;

/**
 * What a user chose, which is much smaller than what gets compiled: the roots are derived from the
 * space's own environments and this Mac's home directory, so storing them would mean a settings row
 * that goes stale the moment a worktree is added.
 */
export const ExecutionSandboxPrefsSchema = z.object({
  posture: ExecutionSandboxPostureSchema.default(EXECUTION_SANDBOX_DEFAULT_POSTURE),
  network: z.boolean().default(true),
});
export type ExecutionSandboxPrefs = z.infer<typeof ExecutionSandboxPrefsSchema>;

/** The posture every space inherits. */
export const EXECUTION_SANDBOX_DEFAULT_KEY = "executionSandbox.default";
/** One space's override, or absent to inherit. Same `spaceId` suffix shape as `mcp.enabled:` and
 *  `computer.allowedApps:`, so the settings table stays greppable by feature. */
export const executionSandboxSpaceKey = (spaceId: string): string => `executionSandbox.space:${spaceId}`;

/**
 * A settings row is user-editable JSON on disk, so this never throws and never returns a partial.
 * Anything unparseable reads as "not chosen", which the caller turns into the inherited value —
 * the same contract `parseUsageBudget` keeps.
 */
export function parseExecutionSandboxPrefs(raw: unknown): ExecutionSandboxPrefs | null {
  if (raw === null || raw === undefined) return null;
  const r = ExecutionSandboxPrefsSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * Every sandbox refusal is one of these, and each one is a different thing for a person to do. A
 * word rather than a sentence, for `MACHINE_ERRORS`' reason: a code survives translation and grep.
 */
export const EXECUTION_SANDBOX_ERRORS = [
  /** `/usr/bin/sandbox-exec` is not on this machine, or is not executable. */
  "sandbox_unavailable",
  /** Not macOS. Seatbelt is a Darwin facility; there is no Linux fallback in this release. */
  "unsupported_platform",
  /** The resolved policy could not be compiled — a relative root, `/`, a `..`, an empty string. */
  "policy_invalid",
] as const;
export type ExecutionSandboxError = (typeof EXECUTION_SANDBOX_ERRORS)[number];

/** The RPC error code the server raises for each. Kept beside the words so the renderer can map one
 *  to the other without a second table. */
export const EXECUTION_SANDBOX_ERROR_CODES: Record<ExecutionSandboxError, string> = {
  sandbox_unavailable: "SANDBOX_UNAVAILABLE",
  unsupported_platform: "SANDBOX_UNSUPPORTED_PLATFORM",
  policy_invalid: "SANDBOX_POLICY_INVALID",
};

/**
 * Cache directories a toolchain genuinely needs to write, relative to the user's home.
 *
 * Each entry is here because a build FAILS without it, not because it looked tidy — an agent whose
 * `pnpm install` cannot reach its store is an agent that reports a broken repo, and the user blames
 * Realm rather than the sandbox. The rejected alternative was making the whole of `~/.cache` and
 * `~/Library/Caches` writable, which is most of the interesting state on a developer's Mac
 * (including browser profiles and `~/Library/Caches/com.apple.*`).
 *
 * What this costs, said out loud: a cache is a place a later UNSANDBOXED command reads from. An
 * agent that can write `~/.npm/_cacache` can plant a package tarball that a `pnpm install` outside
 * the sandbox will happily unpack. Cache poisoning is NOT covered by this feature, and cannot be
 * while the alternative is a toolchain that does not run.
 */
export const TOOLCHAIN_CACHE_DIRS: readonly string[] = [
  ".npm",                         // npm's _cacache and _logs
  ".cache",                       // XDG-ish: pnpm on some setups, uv, turbo, many others
  ".local/share/pnpm",            // pnpm's global store + bin (Linux-style layout pnpm also uses here)
  ".local/state",                 // pnpm writes its own logs here
  "Library/pnpm",                 // pnpm's macOS home
  "Library/Caches/pnpm",
  "Library/Caches/pip",
  "Library/Caches/Homebrew",      // a `brew` a build script calls; NOT /opt/homebrew, see below
  "Library/Caches/ms-playwright", // playwright browser downloads, which tests do on first run
  ".cargo",                       // registry index + git checkouts; also .cargo/bin, see the note
  ".rustup",
  "go/pkg/mod",                   // GOMODCACHE, the only part of ~/go a build must write
  ".gradle",
  ".m2",
  ".bun/install/cache",
  ".deno",
] as const;

/**
 * The agent CLIs' own state directories, relative to home. Writable, because without them there is
 * no feature: `claude` writes its transcripts to `~/.claude/projects`, `codex` its rollouts to
 * `~/.codex/sessions`, and a CLI that cannot write its own state does not start a session at all.
 *
 * This is the largest deliberate hole in the default posture and it is worth being exact about what
 * it costs. These directories hold two dangerous kinds of file:
 *
 *  - **Executable configuration** — `settings.json` hooks, `config.toml`. Those specific files are
 *    in `AGENT_EXECUTABLE_CONFIG` below and are denied WRITE while staying readable, because an
 *    agent that could edit them could arrange for a command to run the next time you use that CLI
 *    outside Realm, where nothing is confining it.
 *  - **Prompt-shaped files** — `~/.claude/CLAUDE.md`, a skills directory, a plugin folder. A
 *    sandboxed agent CAN write those, and a later session of the same CLI will read them. That is
 *    cross-session prompt injection, it is NOT covered, and the only real fix is a per-session state
 *    directory, which is a change to how Realm launches each CLI rather than to this policy.
 *
 * Listed by hand rather than derived from the adapter registry: this is a security boundary, and it
 * should change only when somebody edits it on purpose.
 */
export const AGENT_STATE_DIRS: readonly string[] = [
  ".claude", ".codex", ".cursor", ".gemini", ".copilot", ".qwen", ".grok", ".openhands", ".agents",
  ".config/opencode", ".local/share/opencode", ".config/goose", ".local/share/goose", ".config/fx", ".hermes",
] as const;

/**
 * Files that are read by a toolchain on every run and that can make it EXECUTE something. Readable,
 * never writable — see `readOnlyPaths`.
 *
 * A list, which means it is exactly as complete as whoever last edited it. A CLI that gains a new
 * hook file, or one Realm has never heard of, is not covered. Stated so nobody reads this as "the
 * agent cannot arrange to run code later"; the accurate sentence is "the ways Realm knows about are
 * closed".
 */
export const AGENT_EXECUTABLE_CONFIG: readonly string[] = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/plugins",
  ".codex/config.toml",
  ".cursor/cli-config.json",
  ".gitconfig",
  ".config/git",
  ".zshrc", ".zprofile", ".zshenv", ".zlogin",
  ".bashrc", ".bash_profile", ".profile",
  ".config/fish",
  "Library/LaunchAgents",
] as const;

/**
 * Prefixes under the home directory that stay unreadable under `workspace-write`.
 *
 * These are credentials, not preferences — a token in one of them is a token that works from
 * anywhere on the internet, which is a strictly worse thing to leak than a source file. The list is
 * deliberately about SECRETS AT REST and not about privacy: `~/Documents` and `~/Photos` are
 * readable, and saying otherwise would be a claim this feature does not make.
 *
 * `~/.npmrc`, `~/.gitconfig` and `~/.zshrc` are NOT here even though `.npmrc` can hold a registry
 * token: npm reads it on every install and denying it breaks private registries outright. That is a
 * known hole, chosen over a sandbox that cannot install dependencies.
 */
export const CREDENTIAL_DIRS: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".config/gh",                    // GitHub CLI's hosts.yml — an OAuth token in plain text
  ".config/gcloud",
  ".azure",
  ".netrc",                        // a file, not a directory; `subpath` matches a regular file too
  ".authinfo",
  "Library/Keychains",
  "Library/Application Support/com.apple.TCC",
  "Library/Group Containers/group.com.apple.notes",
] as const;

/** What Settings says, in design.md's register: name the thing, not the feeling. */
export const EXECUTION_SANDBOX_COPY: Record<ExecutionSandboxPosture, { label: string; detail: string }> = {
  "workspace-write": {
    label: "Workspace write",
    detail: "Agents and terminals may write to this space's checkouts, their build caches, the agent CLI's own state folder, and their temp directory — and nowhere else. Credential folders such as ~/.ssh and ~/.aws are unreadable, and files that make something run later (~/.claude/settings.json, ~/.gitconfig, ~/.zshrc) can be read but not changed. The network stays open — an agent that cannot reach its own API cannot run — so this limits what a session can damage or read, not what it can send.",
  },
  "read-only": {
    label: "Read only",
    detail: "Agents and terminals may write nothing but their own temp directory. Edits, installs and builds will fail. Credential folders stay unreadable.",
  },
  off: {
    label: "No sandbox",
    detail: "Agents and terminals run with your full account: every file you can read, they can read, and every file you can write, they can write. This is what Realm did before sandboxing existed.",
  },
};

/** The switch itself, above the three choices. */
export const EXECUTION_SANDBOX_SECTION_COPY = {
  label: "Sandbox agent and terminal processes",
  detail: "Realm applies a macOS Seatbelt policy when it starts an agent CLI or a shell. Seatbelt is not a container: it confines file access and networking for the process and everything it starts, but the process still shares this Mac with everything else on it. If Seatbelt cannot be applied, sessions refuse to start rather than starting unprotected.",
  /** Shown beside the posture picker, because a person deciding this deserves to know the mechanism
   *  is one Apple has marked deprecated — and that Realm has verified it still works. */
  deprecationNote: "macOS marks `sandbox-exec` deprecated. It is present and working on macOS 27; Realm checks for it at startup and says so here if it ever goes away.",
  /** Why the picker starts on "No sandbox". A default nobody chose that silently broke a build would
   *  be read as Realm being broken — see `EXECUTION_SANDBOX_DEFAULT_POSTURE`. */
  defaultNote: "New spaces start with no sandbox. This is the first release of it, so turn it on for one space, run a build there, and check nothing you need is refused before you rely on it.",
  /** The Codex limitation, beside the switch rather than in a release note: the alternative is a
   *  person discovering it as a session that will not start. See `codex-adapter.ts`. */
  codexNote: "Codex sessions cannot be sandboxed in this release. Realm runs one shared `codex app-server` process behind every Codex session, and one process can hold only one policy — so a Codex session in a sandboxed space refuses to start instead of running unprotected. Set this space to No sandbox to use Codex here.",
} as const;

/** One sentence for a session's detail well, from a policy that has already been resolved. */
export function describeExecutionSandbox(p: ExecutionSandboxPolicy): string {
  if (p.posture === "off") return "Not sandboxed — this session runs with your full account.";
  const roots = p.writableRoots.length;
  const writes = p.posture === "read-only"
    ? "writes nothing but its own temp directory"
    : `writes ${roots === 1 ? "1 allowed root" : `${roots} allowed roots`}`;
  const reads = p.readableRoots.length > 0
    ? `reads ${p.readableRoots.length} allowed roots`
    : `reads everything except ${p.protectedRoots.length} protected paths`;
  return `Sandboxed: ${writes}, ${reads}, network ${p.network ? "allowed" : "blocked"}.`;
}
