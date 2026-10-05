import { describe, expect, it } from "vitest";
import { AGENT_META } from "./presets";
import { identifyProgram, isInterpreterName, isShellName, sameProgram, TERMINAL_PROGRAM_MARKS } from "./terminal-programs";

/** argv the way `ps -o args=` prints it: one string, split on spaces. */
const run = (comm: string, args: string | null) => identifyProgram({ comm, argv: args === null ? null : args.split(" ") });

describe("identifyProgram", () => {
  /* The forms measured on this Mac with `ps -o pid,ucomm,args`, 2026-10-04. The kernel's name
     (ucomm) and argv[0] disagree in every one of the agent cases, which is the whole reason the
     argv is read at all. */
  it("names a native Claude by what was typed, though the kernel calls it after its version file", () => {
    // ~/.local/bin/claude is a symlink to ~/.local/share/claude/versions/2.1.283.
    expect(run("2.1.283", "claude")).toEqual({ id: "claude", label: "claude", mark: AGENT_META.claude.icon, agent: true });
    // A launcher that execs the resolved path: the installer's directory names it.
    expect(run("2.1.283", "/Users/me/.local/share/claude/versions/2.1.283 --resume")).toMatchObject({ id: "claude" });
  });

  it("looks through node to the agent script it runs, by name, by package and by install directory", () => {
    expect(run("node", "node /Users/me/.nvm/versions/node/v22.23.2/bin/codex app-server"))
      .toEqual({ id: "codex", label: "codex", mark: AGENT_META.codex.icon, agent: true });
    expect(run("node", "node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toMatchObject({ id: "claude" });
    expect(run("node", "node /opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js")).toMatchObject({ id: "gemini", mark: "gemini" });
    expect(run("node", "node /opt/homebrew/bin/qwen")).toMatchObject({ id: "qwen", agent: true });
  });

  it("names Cursor's agent through the name its launcher gives node, and through its install directory", () => {
    const index = "/Users/me/.local/share/cursor-agent/versions/2026.07.25-e42b078/index.js";
    expect(run("node", `/Users/me/.local/bin/cursor-agent --use-system-ca ${index}`)).toMatchObject({ id: "cursor-agent", mark: "cursor" });
    // The `agent` alias: argv[0] says nothing, the script's directory says Cursor.
    expect(run("node", `/Users/me/.local/bin/agent --use-system-ca ${index}`)).toMatchObject({ id: "cursor-agent" });
  });

  it("follows a package runner to the package, wherever npx itself lives", () => {
    expect(run("node", "node /opt/homebrew/bin/npx @anthropic-ai/claude-code")).toMatchObject({ id: "claude" });
    expect(run("node", "node /opt/homebrew/bin/npx --yes @openai/codex")).toMatchObject({ id: "codex" });
    expect(run("bunx", "bunx opencode-ai")).toMatchObject({ id: "opencode" });
  });

  it("gives every agent Realm also runs as a session the same mark the model picker draws", () => {
    for (const [command, kind] of [["gemini", "acp:gemini"], ["opencode", "acp:opencode"], ["goose", "acp:goose"],
      ["copilot", "acp:copilot"], ["grok", "acp:grok"], ["fx", "acp:fx"], ["openhands", "acp:openhands"]] as const) {
      expect(run(command, command), command).toMatchObject({ mark: AGENT_META[kind].icon, agent: true });
    }
    // An agent with no adapter keeps the tile — it is still an agent — with the generic glyph.
    expect(run("python3", "/Users/me/.local/pipx/venvs/aider-chat/bin/python /Users/me/.local/bin/aider")).toEqual({ id: "aider", label: "aider", mark: "bot", agent: true });
  });

  it("names the shell's own prompt as nothing at all, however it was started", () => {
    expect(run("zsh", "-zsh")).toBeNull();
    expect(run("zsh", "/bin/zsh -l")).toBeNull();
    expect(run("bash", "bash")).toBeNull();
    expect(run("fish", "/opt/homebrew/bin/fish")).toBeNull();
  });

  it("names an interpreter by its language when the code came on the command line or there is no script", () => {
    expect(run("Python", "python3 -c import time; time.sleep(30)")).toEqual({ id: "python", label: "python3", mark: "python", agent: false });
    expect(run("node", "node")).toEqual({ id: "node", label: "node", mark: "javascript", agent: false });
    expect(run("node", "node --inspect -r ts-node/register server.ts")).toMatchObject({ id: "node" });
    // The framework build re-execs itself as Python.app; a reader still sees python.
    expect(run("Python", "/opt/homebrew/Cellar/python@3.12/3.12.1/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python manage.py runserver"))
      .toMatchObject({ id: "python", label: "python" });
  });

  it("takes a module as the program only when it is the interpreter's own tool", () => {
    expect(run("python3.12", "python3 -m pytest -q")).toMatchObject({ id: "python", label: "pytest" });
    expect(run("python3.12", "python3 -m pip install x")).toMatchObject({ id: "package", label: "pip" });
    // http.server is Python serving a folder — not httpie, whose command is also `http`.
    expect(run("python3.12", "python3 -m http.server 8000")).toMatchObject({ id: "python", label: "python3" });
  });

  it("does not take a folder somebody named after a tool for the tool", () => {
    // Only an agent's install directory names a script; a `git` folder is just a folder.
    expect(run("node", "node /Users/me/projects/git/tools/run.js")).toMatchObject({ id: "node" });
    expect(run("node", "node /Users/me/code/claude/server.js")).toMatchObject({ id: "node" });
  });

  it("names a dev server by the package manager it was started through", () => {
    expect(run("node", "node /opt/homebrew/bin/pnpm dev")).toEqual({ id: "package", label: "pnpm", mark: "package", agent: false });
    expect(run("node", "node /Users/me/.nvm/versions/node/v22.23.2/bin/npm run dev")).toMatchObject({ label: "npm", mark: "package" });
    expect(run("bun", "bun run dev")).toMatchObject({ id: "bun", mark: "javascript" });
  });

  it("looks through the wrappers to what they run, past their flags and the values those take", () => {
    expect(run("sudo", "sudo vim /etc/hosts")).toMatchObject({ id: "editor", label: "vim", mark: "edit" });
    expect(run("sudo", "sudo -u deploy nvim notes.md")).toMatchObject({ label: "nvim" });
    expect(run("env", "env NODE_ENV=production node server.js")).toMatchObject({ id: "node" });
    expect(run("caffeinate", "caffeinate -i claude")).toMatchObject({ id: "claude" });
    expect(run("nice", "nice -n 10 make -j8")).toMatchObject({ id: "build", label: "make" });
  });

  it("gives the common tools a glyph from the app's own set", () => {
    const cases: [string, string, string][] = [
      ["ssh", "ssh me@box", "machine"], ["git", "git log --oneline", "branch"], ["gh", "gh pr view 97", "branch"],
      ["docker", "docker compose up", "cube"], ["psql", "psql -d app", "database"], ["sqlite3", "sqlite3 realm.db", "database"],
      ["htop", "htop", "activity"], ["make", "make build", "tool"], ["cargo", "cargo run", "package"], ["go", "go run .", "code"],
      ["ruby", "ruby app.rb", "gem"], ["deno", "deno task dev", "typescript"], ["less", "less README.md", "artifact"],
      ["sleep", "sleep 30", "clock"], ["tmux", "tmux attach", "layout"],
    ];
    for (const [comm, args, mark] of cases) expect(run(comm, args), args).toMatchObject({ mark, agent: false, label: comm });
  });

  it("names a program it does not know, under the terminal glyph", () => {
    expect(run("my-tool", "./my-tool --watch")).toEqual({ id: "my-tool", label: "my-tool", mark: "terminal", agent: false });
  });

  it("reads the kernel's name alone when the argv could not be read — and says nothing for a version number", () => {
    expect(run("htop", null)).toMatchObject({ id: "monitor" });
    expect(run("2.1.283", null)).toBeNull();
  });
});

describe("what the server asks for", () => {
  it("needs no argv for a shell, and re-reads an interpreter's because its program can change under one name", () => {
    expect(isShellName("zsh")).toBe(true);
    expect(isShellName("-zsh")).toBe(true);
    expect(isShellName("2.1.283")).toBe(false);
    expect(isInterpreterName("node")).toBe(true);
    expect(isInterpreterName("Python")).toBe(true);
    expect(isInterpreterName("claude")).toBe(false);
  });

  it("compares programs by what the tab would draw", () => {
    expect(sameProgram(null, null)).toBe(true);
    expect(sameProgram(run("vim", "vim"), run("vi", "vi"))).toBe(false); // same family, a different word on the tab
    expect(sameProgram(run("vim", "vim a"), run("vim", "vim b"))).toBe(true);
    expect(sameProgram(run("vim", "vim"), null)).toBe(false);
  });

  it("lists every mark it can produce, so the renderer can check each draws", () => {
    expect(TERMINAL_PROGRAM_MARKS).toContain("terminal");
    expect(TERMINAL_PROGRAM_MARKS).toContain(AGENT_META.claude.icon);
    expect(TERMINAL_PROGRAM_MARKS).toContain("python");
  });
});
