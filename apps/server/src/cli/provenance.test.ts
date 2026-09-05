import { tempDir } from "@realm/test-utils";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyPath, resolveInstall } from "./provenance";
import { agentBin } from "./bins";
import { probeClaude } from "@realm/adapters";


function tree(): string {
  const root = tempDir("realm-cli-");
  return root;
}

/** A real executable file, and a PATH symlink pointing at it — the layout every package manager here
 *  produces, and the only one `resolveInstall` is allowed to reason about. */
function install(root: string, opts: { real: string; link: string }): { binDir: string } {
  const realPath = join(root, opts.real);
  mkdirSync(dirname(realPath), { recursive: true });
  writeFileSync(realPath, "#!/bin/sh\n", { mode: 0o755 });
  const linkPath = join(root, opts.link);
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(realPath, linkPath);
  return { binDir: dirname(linkPath) };
}

describe("classifyPath", () => {
  it("reads both of Homebrew's install roots as brew", () => {
    // Formulae land in Cellar and casks in Caskroom; `codex` is a cask on the machine this was
    // measured on, and calling that "not a package manager Realm recognises" would be a false
    // sentence shown to a Homebrew user.
    expect(classifyPath("/opt/homebrew/Cellar/block-goose-cli/1.49.0/bin/goose")).toBe("brew");
    expect(classifyPath("/opt/homebrew/Caskroom/codex/0.146.0/bin/codex")).toBe("brew");
  });

  it("reads the vendor self-updater layouts as unknown, which is the common case", () => {
    // Measured 2026-09-05: four of the five agent CLIs installed on a working machine look like this.
    expect(classifyPath("/Users/x/.local/share/claude/versions/2.1.258")).toBe("unknown");
    expect(classifyPath("/Users/x/.local/share/cursor-agent/versions/2026.07.25-e42b078/cursor-agent")).toBe("unknown");
    expect(classifyPath("/Users/x/.opencode/bin/opencode")).toBe("unknown");
    expect(classifyPath("/Users/x/.local/bin/fx")).toBe("unknown");
  });

  it("reads a global node_modules as npm", () => {
    expect(classifyPath("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js")).toBe("npm");
  });

  it("reads a pnpm store as pnpm, not as the npm its node_modules would suggest", () => {
    expect(classifyPath("/Users/x/Library/pnpm/global/5/.pnpm/@openai+codex@1.0.0/node_modules/@openai/codex/bin/codex.js")).toBe("pnpm");
  });

  it("prefers brew when a formula vendors a node_modules tree inside its keg", () => {
    // `npm install -g` would not upgrade this copy, so calling it npm would be the dangerous answer.
    expect(classifyPath("/opt/homebrew/Cellar/opencode/1.2.3/libexec/node_modules/opencode-ai/bin/opencode")).toBe("brew");
  });

  it("reads a plain downloaded binary as unknown", () => {
    expect(classifyPath("/Users/x/.local/bin/cursor-agent")).toBe("unknown");
  });

  it("matches whole path segments, so a user directory that merely contains the word does not count", () => {
    expect(classifyPath("/Users/x/Cellar-backups/goose")).toBe("unknown");
    expect(classifyPath("/Users/x/node_modules-notes/codex")).toBe("unknown");
  });
});

describe("resolveInstall", () => {
  it("follows the PATH symlink to the real file and classifies that, not the PATH directory", async () => {
    // The case the whole module exists for: brew and npm share /opt/homebrew/bin, so the directory a
    // binary is found in proves nothing.
    const root = tree();
    const { binDir } = install(root, { real: "Cellar/block-goose-cli/1.9.0/bin/goose", link: "bin/goose" });
    install(root, { real: "lib/node_modules/@openai/codex/bin/codex.js", link: "bin/codex" });
    const env = { PATH: binDir };
    expect((await resolveInstall("goose", env))?.provenance).toBe("brew");
    expect((await resolveInstall("codex", env))?.provenance).toBe("npm");
  });

  it("reports the PATH entry it found and the real file separately", async () => {
    const root = tree();
    const { binDir } = install(root, { real: "lib/node_modules/opencode-ai/bin/opencode", link: "bin/opencode" });
    const found = await resolveInstall("opencode", { PATH: binDir });
    expect(found?.path).toBe(join(binDir, "opencode"));
    expect(found?.realPath).toContain(join("node_modules", "opencode-ai"));
  });

  it("takes the first PATH entry that holds it, as a spawn would", async () => {
    const root = tree();
    const a = install(root, { real: "Cellar/x/1/bin/tool", link: "first/tool" });
    const b = install(root, { real: "lib/node_modules/x/bin/tool", link: "second/tool" });
    expect((await resolveInstall("tool", { PATH: `${a.binDir}:${b.binDir}` }))?.provenance).toBe("brew");
    expect((await resolveInstall("tool", { PATH: `${b.binDir}:${a.binDir}` }))?.provenance).toBe("npm");
  });

  it("skips a non-executable file and keeps searching", async () => {
    const root = tree();
    const dead = join(root, "dead");
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, "tool"), "not executable", { mode: 0o644 });
    const live = install(root, { real: "lib/node_modules/x/bin/tool", link: "live/tool" });
    expect((await resolveInstall("tool", { PATH: `${dead}:${live.binDir}` }))?.provenance).toBe("npm");
  });

  it("skips a dangling symlink rather than claiming an install", async () => {
    const root = tree();
    const brokenDir = join(root, "broken");
    mkdirSync(brokenDir, { recursive: true });
    symlinkSync(join(root, "nowhere", "tool"), join(brokenDir, "tool"));
    expect(await resolveInstall("tool", { PATH: brokenDir })).toBe(null);
  });

  it("answers null when nothing on PATH holds it, and when PATH is empty", async () => {
    const root = tree();
    expect(await resolveInstall("nothing-here", { PATH: root })).toBe(null);
    expect(await resolveInstall("nothing-here", {})).toBe(null);
  });

  it("uses an explicit path as given instead of searching PATH", async () => {
    const root = tree();
    install(root, { real: "Cellar/x/1/bin/tool", link: "bin/tool" });
    const found = await resolveInstall(join(root, "bin", "tool"), { PATH: "/nonexistent" });
    expect(found?.provenance).toBe("brew");
  });
});

describe("agentBin", () => {
  it("names a binary for every kind but the compiled-in fake", () => {
    expect(agentBin("fake", {})).toBe(null);
    expect(agentBin("codex", {})).toBe("codex");
    expect(agentBin("acp:cursor", {})).toBe("cursor-agent");
    expect(agentBin("acp:deepseek", {})).toBe("dsh-acp-demo");
  });

  it("honours the same REALM_*_BIN override the adapters read", () => {
    expect(agentBin("acp:opencode", { REALM_OPENCODE_BIN: "/tmp/stub" })).toBe("/tmp/stub");
    expect(agentBin("acp:opencode", { REALM_OPENCODE_BIN: "  " })).toBe("opencode");
  });

  it("shares REALM_CLAUDE_BIN with probeClaude, so an override moves the probe and the lookup together", async () => {
    // The env var name is the only thing binding this table to the adapter that owns the default;
    // a probe run under the override must land on the very binary agentBin names.
    const root = tree();
    install(root, { real: "Cellar/claude/1/bin/claude", link: "bin/claude" });
    const stub = join(root, "bin", "claude");
    const prev = process.env.REALM_CLAUDE_BIN;
    process.env.REALM_CLAUDE_BIN = stub;
    try {
      expect(agentBin("claude")).toBe(stub);
      // The stub is `#!/bin/sh` with no output: it runs, so the probe reports available.
      expect((await probeClaude()).available).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.REALM_CLAUDE_BIN; else process.env.REALM_CLAUDE_BIN = prev;
    }
  });
});
