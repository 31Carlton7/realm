import { symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { newestExecutable } from "./newest-executable";

/** A `codex` in its own directory that prints `out` for `--version`. */
function fakeCli(out: string, name = "codex"): string {
  const dir = tempDir("realm-newest-");
  writeFileSync(join(dir, name), `#!/bin/sh\necho '${out}'\n`, { mode: 0o755 });
  return dir;
}

const path = (...dirs: string[]) => ({ PATH: dirs.join(":") });

describe.skipIf(process.platform === "win32")("newestExecutable", () => {
  it("runs a newer copy later on PATH over a stale one earlier", async () => {
    // The measured case: brew's 0.146.0 ahead of nvm's 0.166.0 on the server's PATH.
    const brew = fakeCli("codex-cli 0.146.0");
    const nvm = fakeCli("codex-cli 0.166.0");
    expect(await newestExecutable("codex", path(brew, nvm))).toBe(join(nvm, "codex"));
    expect(await newestExecutable("codex", path(nvm, brew))).toBe(join(nvm, "codex"));
  });

  it("compares versions as numbers, not strings", async () => {
    const nine = fakeCli("2.1.9 (Claude Code)", "claude");
    const ten = fakeCli("2.1.10 (Claude Code)", "claude");
    expect(await newestExecutable("claude", path(nine, ten))).toBe(join(ten, "claude"));
  });

  it("keeps PATH order on a tie, and when the first copy states no version", async () => {
    const a = fakeCli("codex-cli 0.166.0");
    const b = fakeCli("codex-cli 0.166.0");
    expect(await newestExecutable("codex", path(a, b))).toBe(join(a, "codex"));
    const silent = fakeCli("usage: codex");
    expect(await newestExecutable("codex", path(silent, b))).toBe(join(silent, "codex"));
  });

  it("does not trade a working copy for one whose --version fails", async () => {
    const good = fakeCli("codex-cli 0.146.0");
    const broken = tempDir("realm-newest-");
    writeFileSync(join(broken, "codex"), "#!/bin/sh\necho 'codex-cli 9.9.9'; exit 1\n", { mode: 0o755 });
    expect(await newestExecutable("codex", path(good, broken))).toBe(join(good, "codex"));
  });

  it("reads a copy again after it is upgraded in place", async () => {
    const old = fakeCli("codex-cli 0.146.0");
    const other = fakeCli("codex-cli 0.150.0");
    expect(await newestExecutable("codex", path(old, other))).toBe(join(other, "codex"));
    writeFileSync(join(old, "codex"), "#!/bin/sh\necho 'codex-cli 0.166.0'\n", { mode: 0o755 });
    utimesSync(join(old, "codex"), new Date(), new Date(Date.now() + 5000));
    expect(await newestExecutable("codex", path(old, other))).toBe(join(old, "codex"));
  });

  it("treats two links to one file as one copy, and uses a path as given", async () => {
    const real = fakeCli("codex-cli 0.166.0");
    const link = tempDir("realm-newest-");
    symlinkSync(join(real, "codex"), join(link, "codex"));
    expect(await newestExecutable("codex", path(link, real))).toBe(join(link, "codex"));
    expect(await newestExecutable(join(real, "codex"), path(fakeCli("codex-cli 1.0.0")))).toBe(join(real, "codex"));
    expect(await newestExecutable("codex", path())).toBeNull();
  });
});
