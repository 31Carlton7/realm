import { z } from "zod";
import type { AgentKind } from "./entities";
import { AGENT_META } from "./presets";

/**
 * What a terminal is running, named the way its tab says it: a glyph and a word.
 *
 * The server reads the pty's FOREGROUND process — the leader of the process group the terminal is
 * handing its keystrokes to — and this module turns that into a program. Only the program crosses the
 * wire, never the argv it was read from: a command line is whatever someone typed, a token on a
 * `curl -H` included, and the tab needs a name and a mark, not the line.
 *
 * Null means the shell itself: the prompt, or a shell started inside it. That is the state a terminal
 * spends most of its life in, and the tab keeps the terminal glyph and the title it always had.
 */
export const TerminalProgramSchema = z.object({
  /** The program's family, stable across the names it answers to: `python` for python3.12, `vim`
   *  for vi. What a renderer keys an icon swap on. */
  id: z.string(),
  /** The word the tab prints before the folder — "claude · realm". The name it was started by, as
   *  the person typed it, rather than the family's: someone who runs `nvim` reads "nvim". */
  label: z.string(),
  /** An `IconName` from `@realm/ui`: the vendor's mark for an agent, a glyph from the app's own set
   *  for a tool, and the terminal glyph for a program this table does not know. */
  mark: z.string(),
  /** An agent wears its mark on a tile, the way the reference's Claude and fx tabs do. A tool keeps
   *  a bare glyph — a strip of tabs in every vendor's colour would read as state, which is the one
   *  thing colour is reserved for. */
  agent: z.boolean(),
});
export type TerminalProgram = z.infer<typeof TerminalProgramSchema>;

/** What the server could read about the foreground process group's leader. */
export type ForegroundProcess = {
  /**
   * The kernel's short name for it (`p_comm`, at most 16 characters) — node-pty's `process`.
   *
   * It is the name of the file that was EXECUTED, which is not always the name that was typed. A
   * binary reached through a symlink reports the link's target: Claude's native installer links
   * `~/.local/bin/claude` to a file named after its version, so a running Claude reads "2.1.283"
   * here (measured on this Mac). A script reports its interpreter: npm's `codex` reads "node".
   * Neither says what is running, which is why the argv is read as well.
   */
  comm: string;
  /** Its argv, split on spaces, when `ps` could read it; null when it could not. */
  argv: readonly string[] | null;
};

type ProgramDef = { id: string; mark: string; agent: boolean; names: readonly string[] };

/** An agent Realm can also run as a session takes its mark from `AGENT_META`, so the tab and the
 *  model picker draw the same vendor with the same glyph and the two cannot drift apart. */
const agent = (id: string, kind: AgentKind, names: readonly string[]): ProgramDef =>
  ({ id, mark: AGENT_META[kind].icon, agent: true, names });

/** An agent with no session adapter in Realm, and so no vendored mark: the generic agent glyph, on
 *  the same tile — it is still an agent in the terminal, which is the thing the tile says. */
const otherAgent = (id: string, names: readonly string[]): ProgramDef => ({ id, mark: "bot", agent: true, names });

const tool = (id: string, mark: string, names: readonly string[]): ProgramDef => ({ id, mark, agent: false, names });

/**
 * Every program the tab has a name and a mark for, by the names it is started with. A name may be
 * the command, an npm package (`npx @openai/codex`), or a directory an installer keeps it in
 * (`~/.local/share/cursor-agent/versions/…/index.js`) — the three forms an agent CLI arrives in.
 */
const PROGRAMS: readonly ProgramDef[] = [
  agent("claude", "claude", ["claude", "claude-code", "@anthropic-ai/claude-code"]),
  agent("codex", "codex", ["codex", "@openai/codex"]),
  agent("gemini", "acp:gemini", ["gemini", "@google/gemini-cli"]),
  agent("cursor-agent", "acp:cursor", ["cursor-agent"]),
  agent("opencode", "acp:opencode", ["opencode", "opencode-ai"]),
  agent("copilot", "acp:copilot", ["copilot", "@github/copilot"]),
  agent("goose", "acp:goose", ["goose"]),
  agent("qwen", "acp:qwen", ["qwen", "@qwen-code/qwen-code"]),
  agent("grok", "acp:grok", ["grok", "@xai-official/grok"]),
  /* `fx` is also a JSON viewer's name. The agent is the one Realm ships an adapter for, and a tile on
     a JSON viewer is a smaller mistake than a terminal glyph on the agent the reference shows. */
  agent("fx", "acp:fx", ["fx"]),
  agent("openhands", "acp:openhands", ["openhands"]),
  agent("hermes", "acp:hermes", ["hermes", "hermes-agent"]),
  agent("dsh", "acp:deepseek", ["dsh", "@deepseek-ai/dsh"]),
  otherAgent("aider", ["aider", "aider-chat"]),
  otherAgent("amp", ["amp", "@sourcegraph/amp"]),
  otherAgent("crush", ["crush", "@charmland/crush"]),

  tool("node", "javascript", ["node", "nodejs"]),
  tool("bun", "javascript", ["bun"]),
  tool("deno", "typescript", ["deno"]),
  tool("tsx", "typescript", ["tsx", "ts-node"]),
  tool("python", "python", ["python", "python2", "python3", "pythonw", "ipython", "ipython3", "jupyter", "pytest"]),
  tool("ruby", "gem", ["ruby", "irb", "rails", "rake", "bundle", "bundler"]),
  tool("go", "code", ["go"]),
  tool("rustc", "code", ["rustc"]),
  tool("java", "java", ["java", "javac", "jshell"]),
  tool("php", "php", ["php"]),
  /* A package manager is what most dev servers are started through (`pnpm dev`), so its mark is the
     one a dev server wears. */
  tool("package", "package", ["npm", "pnpm", "yarn", "cargo", "uv", "pip", "pip3", "pipx", "poetry", "brew", "gradle", "mvn", "composer"]),
  tool("editor", "edit", ["vim", "vi", "view", "vimdiff", "nvim", "emacs", "emacsclient", "nano", "hx", "helix", "micro", "kak"]),
  /* A shell on another machine: the app's glyph for "a screen somewhere else". */
  tool("ssh", "machine", ["ssh", "mosh", "mosh-client", "autossh", "et", "telnet"]),
  tool("git", "branch", ["git", "gh", "lazygit", "tig", "gitui", "jj"]),
  tool("container", "serverStack", ["docker", "podman", "nerdctl", "kubectl", "k9s", "colima", "orb", "orbctl", "minikube"]),
  tool("database", "database", ["psql", "pgcli", "sqlite3", "sqlite", "mysql", "mycli", "mariadb", "redis-cli", "mongosh", "duckdb", "litecli", "usql", "clickhouse"]),
  tool("monitor", "activity", ["top", "htop", "btop", "btm", "glances", "atop", "nvtop", "iotop"]),
  tool("build", "tool", ["make", "gmake", "cmake", "ninja", "just", "bazel", "task"]),
  tool("pager", "artifact", ["less", "more", "most", "man", "bat", "tail", "journalctl", "lnav"]),
  tool("http", "browser", ["curl", "wget", "http", "https", "xh"]),
  tool("wait", "clock", ["sleep", "watch", "timeout", "wait"]),
  tool("multiplexer", "layout", ["tmux", "screen", "zellij"]),
];

const BY_NAME = new Map<string, ProgramDef>(PROGRAMS.flatMap((p) => p.names.map((n) => [n, p] as const)));

/** Every mark the table can produce, for the renderer's check that each one resolves to a glyph. */
export const TERMINAL_PROGRAM_MARKS: readonly string[] = [...new Set(PROGRAMS.map((p) => p.mark)), "terminal"];

/** A shell is the prompt, not a program: no tab change while one is in front. */
const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh"]);

/** Interpreters, which name the language and not the program: the program is the script they run. */
const INTERPRETERS = new Set(["node", "nodejs", "python", "python2", "python3", "pythonw", "ruby", "perl", "php"]);

/** Commands that run ANOTHER command, which is the one being shown — with the flags of theirs that
 *  take a value, so `sudo -u deploy vim` is vim and not a program called "deploy". */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sudo", new Set(["-u", "-g", "-U", "-C", "-h", "-p", "-r", "-t", "-T", "-D"])],
  ["doas", new Set(["-u", "-C"])],
  ["env", new Set(["-u", "-C", "-S", "-P"])],
  ["time", new Set(["-o", "-f"])],
  ["nice", new Set(["-n"])],
  ["nohup", new Set<string>()],
  ["caffeinate", new Set(["-t", "-w"])],
]);

/** Commands that fetch a PACKAGE and run it: the next word is a package name, not a command. */
const RUNNERS = new Set(["npx", "bunx", "pnpx", "uvx"]);

/** Interpreter flags that take the following word as their value rather than being followed by the
 *  script. `-e`, `-p` and `-c` are not here: the code they take IS the program, so nothing follows. */
const VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions",
  "--env-file", "--title", "-W", "-X", "--inspect-port"]);
const CODE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c"]);

/** A script's own name that says nothing about what it is — an entry point, or the version-named
 *  file a native installer keeps — so the directory it was installed into is asked instead. */
const UNNAMED = /^(?:index|cli|main|bin|entry|run|start|app|v?\d+(?:\.\d+)+.*)$/;

/** The last path component, with a login shell's leading dash and a script's extension taken off. */
function commandName(word: string): string {
  const base = word.slice(word.lastIndexOf("/") + 1).replace(/^-/, "");
  return base.replace(/\.(?:[cm]?js|ts|py|rb|pl|php|sh)$/, "");
}

/** `python3.12` and `Python` (the framework build's own re-exec) are both "python3" to a reader. */
function normalise(name: string): string {
  const lower = name.toLowerCase();
  const py = /^(python|pip)(\d)(?:\.\d+)*$/.exec(lower);
  return py ? `${py[1]}${py[2]}` : lower;
}

const looksLikeVersion = (name: string): boolean => /^v?\d+(?:\.\d+)+/.test(name);

const program = (def: ProgramDef, label: string): TerminalProgram =>
  ({ id: def.id, label, mark: def.mark, agent: def.agent });

/** A program the table does not know is still named — "sleep · realm" says something "realm" does
 *  not — and keeps the terminal glyph, which claims nothing about it. */
const unknown = (name: string): TerminalProgram => ({ id: name, label: name, mark: "terminal", agent: false });

/** A word, as a known program — as the npm package it was typed as (`@scope/name`, which is matched
 *  whole, before the path rule below would cut the scope off), or by its command name. */
function lookup(word: string): TerminalProgram | null {
  const scoped = word.startsWith("@") ? BY_NAME.get(word.toLowerCase()) : undefined;
  if (scoped) return program(scoped, scoped.id);
  const name = normalise(commandName(word));
  const def = BY_NAME.get(name) ?? BY_NAME.get(name.replace(/\d+$/, ""));
  return def ? program(def, def.agent ? def.id : name) : null;
}

/**
 * A path whose own name says nothing (`index.js`, `cli.js`, a version number) is named by the
 * directory it was installed into: the nearest component, from the file outward, that names an
 * AGENT. Only an agent, because installers are what put a program's name in a directory — `claude/
 * versions/2.1.283`, `cursor-agent/versions/…/index.js`, `@google/gemini-cli/dist/index.js` — while
 * a `git` or a `python` in a path is far more often a folder somebody named. `@scope/name` is two
 * components, so a component is also tried joined to a scope before it.
 */
function lookupPath(path: string): TerminalProgram | null {
  const parts = path.split("/").filter(Boolean);
  for (let i = parts.length - 2; i >= 0; i--) {
    const found = (i > 0 && parts[i - 1]!.startsWith("@") ? lookup(`${parts[i - 1]}/${parts[i]}`) : null) ?? lookup(parts[i]!);
    if (found?.agent) return found;
  }
  return null;
}

/** The word after an interpreter's flags: the script it runs, `{ code: true }` for code given on
 *  the command line, or null when there is neither (a REPL). */
function scriptOf(args: readonly string[]): { word: string } | { module: string } | { code: true } | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (CODE_FLAGS.has(a)) return { code: true };
    if (a === "-m") return args[i + 1] ? { module: args[i + 1]!.split(".")[0]! } : null;
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    return { word: a };
  }
  return null;
}

/** The first word of `args` that is a command: past the wrapper's own flags, the values those take,
 *  and `NAME=value`. -1 when the wrapper was run with nothing to wrap. */
function commandAfter(args: readonly string[], valueFlags: ReadonlySet<string>): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueFlags.has(a)) { i++; continue; }
    if (a.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue;
    return i;
  }
  return -1;
}

function identifyArgv(argv: readonly string[], comm: string, depth: number): TerminalProgram | null {
  const head = normalise(commandName(argv[0]!));
  if (SHELLS.has(head)) return null;
  if (depth < 4 && (WRAPPERS.has(head) || RUNNERS.has(head))) {
    const rest = argv.slice(1);
    const at = commandAfter(rest, WRAPPERS.get(head) ?? new Set());
    if (at < 0) return lookup(head) ?? unknown(head);
    // A runner's next word is a package: `npx @anthropic-ai/claude-code` is Claude.
    if (RUNNERS.has(head)) return lookup(rest[at]!) ?? unknown(head);
    return identifyArgv(rest.slice(at), comm, depth + 1);
  }
  /* An interpreter names the language. The same is true when it was started under another name —
     Cursor's launcher runs node as `exec -a cursor-agent`, so argv[0] says "cursor-agent" and the
     kernel says "node" — which is why the kernel's name is asked as well as argv[0]'s. */
  const interpreter = INTERPRETERS.has(head) ? head : INTERPRETERS.has(normalise(comm)) && !BY_NAME.has(head) ? normalise(comm) : null;
  if (interpreter) {
    const script = scriptOf(argv.slice(1));
    const own = lookup(interpreter);
    if (!script || "code" in script) return own;
    /* `python -m pytest` is pytest; `python -m http.server` is Python serving a folder, not httpie.
       A module only names the program when it is one of the interpreter's own tools. */
    if ("module" in script) {
      const tool = lookup(script.module);
      return tool && (tool.id === own?.id || tool.id === "package") ? tool : own;
    }
    // A script that is itself a runner — npm's `npx` is `node …/bin/npx` — hands on to its package.
    if (depth < 4 && RUNNERS.has(commandName(script.word))) return identifyArgv(argv.slice(argv.indexOf(script.word)), comm, depth + 1);
    const named = UNNAMED.test(commandName(script.word)) ? lookupPath(script.word) : lookup(script.word);
    return named ?? (head !== interpreter ? lookup(head) ?? lookupPath(argv[0]!) : null) ?? own;
  }
  const named = (looksLikeVersion(head) ? lookupPath(argv[0]!) : lookup(argv[0]!)) ?? lookup(comm);
  if (named) return named;
  const name = looksLikeVersion(head) ? normalise(comm) : head;
  return name && !looksLikeVersion(name) ? unknown(name) : null;
}

/**
 * The program a foreground process is, or null for a shell — and for a process with nothing to call
 * it by, which only happens when `ps` could not read the argv of a binary named after its version.
 */
export function identifyProgram({ comm, argv }: ForegroundProcess): TerminalProgram | null {
  const words = argv && argv.length > 0 && argv[0] ? argv : comm ? [comm] : null;
  return words ? identifyArgv(words, comm, 0) : null;
}

/** Whether the server has to read the argv to know what `comm` is running. A shell needs nothing
 *  more — it is the prompt — and every other name might be an interpreter, a renamed launcher or a
 *  version number, so the argv is what decides. */
export const isShellName = (comm: string): boolean => SHELLS.has(normalise(commandName(comm)));

/** A name whose argv says WHICH program it is: an interpreter runs a different script each time,
 *  so the same name can stand for two programs in a row. The server re-reads these every so often. */
export const isInterpreterName = (comm: string): boolean => INTERPRETERS.has(normalise(commandName(comm)));

export const sameProgram = (a: TerminalProgram | null, b: TerminalProgram | null): boolean =>
  a === b || (!!a && !!b && a.id === b.id && a.label === b.label && a.mark === b.mark && a.agent === b.agent);
