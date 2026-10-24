import { describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { pruneMusl } from "./lib/prune-musl.mjs";

const GLIBC = "@anthropic-ai+claude-agent-sdk-linux-x64@0.3.281";
const MUSL = "@anthropic-ai+claude-agent-sdk-linux-x64-musl@0.3.281";

/** A staged server's .pnpm as `pnpm deploy` leaves it on Linux: the SDK's glibc and musl `claude`
 *  packages, each linked from the SDK's own node_modules and from the hoisted one. */
function staged(): string {
  const pnpm = join(tempDir("prune-musl-"), ".pnpm");
  const scoped = (dir: string) => join(dir, "node_modules", "@anthropic-ai");
  for (const [store, name] of [[GLIBC, "claude-agent-sdk-linux-x64"], [MUSL, "claude-agent-sdk-linux-x64-musl"]]) {
    mkdirSync(join(scoped(join(pnpm, store)), name), { recursive: true });
    writeFileSync(join(scoped(join(pnpm, store)), name, "claude"), "");
    const sdk = scoped(join(pnpm, "@anthropic-ai+claude-agent-sdk@0.3.281"));
    mkdirSync(sdk, { recursive: true });
    symlinkSync(join("..", "..", "..", store, "node_modules", "@anthropic-ai", name), join(sdk, name));
    mkdirSync(scoped(pnpm), { recursive: true });
    symlinkSync(join("..", "..", store, "node_modules", "@anthropic-ai", name), join(scoped(pnpm), name));
  }
  mkdirSync(join(pnpm, "node-pty@1.2.0-beta.15", "node_modules", "node-pty"), { recursive: true });
  return pnpm;
}

const present = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };

describe("pruneMusl", () => {
  it("drops the musl builds and the links to them, and keeps the glibc ones and everything else", () => {
    const pnpm = staged();
    expect(pruneMusl(pnpm)).toEqual([MUSL]);
    expect(present(join(pnpm, MUSL))).toBe(false);
    for (const modules of [join(pnpm, "node_modules"), join(pnpm, "@anthropic-ai+claude-agent-sdk@0.3.281", "node_modules")]) {
      expect(present(join(modules, "@anthropic-ai", "claude-agent-sdk-linux-x64-musl"))).toBe(false);
      expect(existsSync(join(modules, "@anthropic-ai", "claude-agent-sdk-linux-x64", "claude"))).toBe(true);
    }
    expect(existsSync(join(pnpm, "node-pty@1.2.0-beta.15", "node_modules", "node-pty"))).toBe(true);
  });
});
