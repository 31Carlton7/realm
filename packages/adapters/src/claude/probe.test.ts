import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { tempDir } from "@realm/test-utils";
import { bundledClaude, claudeExecutable, probeClaude } from "./probe";

/**
 * What the probe is allowed to claim.
 *
 * `loggedIn: false` is the only answer with a cost: it replaces the prompter with a card telling the
 * user to sign in. So the tests below are mostly about the CLI NOT being read as signed out — an old
 * binary, a keychain that would not open, a line of something that is not JSON. Each of those is a
 * probe that failed, and a probe that failed is not evidence about the user.
 */
function stubbed(body: string): string {
  const bin = join(tempDir("realm-probe-"), "claude");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * A scratch HOME, because the fallback branch reads `~/.claude/.credentials.json` and the machine
 * running this suite is very likely signed in. Without it the two tests about a probe that could not
 * answer would read the developer's own credentials and pass or fail on whose laptop they ran.
 */
let prevKey: string | undefined;
let prevHome: string | undefined;
beforeEach(() => {
  prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  prevHome = process.env.HOME;
  process.env.HOME = tempDir("realm-probe-home-");
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
});

describe("probing the claude CLI", () => {
  it("takes the CLI's own word for being signed in", async () => {
    const bin = stubbed(`
      case "$1" in
        --version) echo "2.1.273 (Claude Code)" ;;
        auth) echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}' ;;
      esac`);
    expect(await probeClaude(bin)).toEqual({ available: true, version: "2.1.273 (Claude Code)", loggedIn: true, reason: null });
  });

  it("takes its word for being signed out, and names the command that fixes it", async () => {
    const bin = stubbed(`
      case "$1" in
        --version) echo "2.1.273" ;;
        auth) echo '{"loggedIn":false}' ;;
      esac`);
    const p = await probeClaude(bin);
    expect(p.loggedIn).toBe(false);
    expect(p.reason).toContain("claude auth login");
  });

  it("takes its word when it says so the way the real CLI does: the JSON, then exit 1", async () => {
    // What 2.1.281 printed signed out, verbatim but for the paths. A stale credentials file sits in
    // HOME, as one did on the machine this was found on: reading the exit as "no answer" sent the
    // probe to the fallback, which saw the file and called a signed-out CLI signed in.
    mkdirSync(join(process.env.HOME!, ".claude"));
    writeFileSync(join(process.env.HOME!, ".claude", ".credentials.json"), "{}");
    const bin = stubbed(`
      case "$1" in
        --version) echo "2.1.281 (Claude Code)" ;;
        auth) printf '{\\n  "loggedIn": false,\\n  "authMethod": "none",\\n  "apiProvider": "firstParty"\\n}\\n'; exit 1 ;;
      esac`);
    expect(await probeClaude(bin)).toMatchObject({ available: true, loggedIn: false });
  });

  it("asks with --json, so a CLI that changes its default format is still answering the question", async () => {
    // The human-readable form parses as nothing, which would read as "cannot tell" on every probe.
    const bin = stubbed(`
      case "$1" in
        --version) echo "2.1.273" ;;
        auth) [ "$3" = "--json" ] && echo '{"loggedIn":true}' || echo "Logged in as someone" ;;
      esac`);
    expect((await probeClaude(bin)).loggedIn).toBe(true);
  });

  it("says nothing rather than 'signed out' when the subcommand does not exist", async () => {
    // A CLI old enough to predate `claude auth status`. Telling that user to log in would be wrong,
    // and it is the wrong answer that costs them something.
    const bin = stubbed(`
      case "$1" in
        --version) echo "1.0.0" ;;
        *) echo "unknown command" >&2; exit 1 ;;
      esac`);
    const p = await probeClaude(bin);
    expect(p.available).toBe(true);
    expect(p.loggedIn).toBeNull();
  });

  it("falls back to ANTHROPIC_API_KEY when the subcommand is missing, since that is a login too", async () => {
    const bin = stubbed(`
      case "$1" in
        --version) echo "1.0.0" ;;
        *) exit 1 ;;
      esac`);
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect((await probeClaude(bin)).loggedIn).toBe(true);
  });

  it("says nothing when the status output is not JSON", async () => {
    const bin = stubbed(`
      case "$1" in
        --version) echo "2.1.273" ;;
        auth) echo "keychain is locked" ;;
      esac`);
    expect((await probeClaude(bin)).loggedIn).toBeNull();
  });

  it("says nothing when the JSON has no verdict in it", async () => {
    const bin = stubbed(`
      case "$1" in
        --version) echo "2.1.273" ;;
        auth) echo '{"authMethod":"claude.ai"}' ;;
      esac`);
    expect((await probeClaude(bin)).loggedIn).toBeNull();
  });

  it("reports a CLI that is not there as unavailable, and asks it nothing further", async () => {
    const p = await probeClaude(join(tmpdir(), "realm-no-such-claude"));
    expect(p).toMatchObject({ available: false, version: null, loggedIn: null });
    expect(p.reason).toBeTruthy();
  });
});

/**
 * The Claude Realm carries. Every session runs the Agent SDK's own binary, so a Mac with no `claude`
 * on PATH can run Claude perfectly well — and the probe used to tell that Mac it was not installed.
 * Realm's copy is always injected here: what is under test is where the probe looks, never the real
 * 220 MB binary.
 */
describe("finding claude when PATH has none", () => {
  const SIGNED_IN = `
    case "$1" in
      --version) echo "2.1.281 (Claude Code)" ;;
      auth) echo '{"loggedIn":true}' ;;
    esac`;
  const SIGNED_OUT = `
    case "$1" in
      --version) echo "2.1.281 (Claude Code)" ;;
      auth) echo '{"loggedIn":false}' ;;
    esac`;
  const noPath = () => ({ PATH: tempDir("realm-probe-nopath-") });
  const carried = (body: string) => { const bin = stubbed(body); return () => bin; };

  it("falls back to the copy Realm carries, and reports its version as printed", async () => {
    expect(await probeClaude(undefined, { env: noPath(), bundled: carried(SIGNED_IN) }))
      .toEqual({ available: true, version: "2.1.281 (Claude Code)", loggedIn: true, reason: null });
  });

  it("prefers the claude on PATH when it runs — that is the person's own CLI", async () => {
    // THE MUTANT: Realm's copy first. Settings would then show Realm's version against the user's
    // CLI, and offer that CLI's updater on the strength of a binary it does not touch.
    const own = stubbed(`
      case "$1" in
        --version) echo "2.1.200 (Claude Code)" ;;
        auth) echo '{"loggedIn":true}' ;;
      esac`);
    const p = await probeClaude(undefined, { env: { PATH: dirname(own) }, bundled: carried(SIGNED_IN) });
    expect(p.version).toBe("2.1.200 (Claude Code)");
  });

  it("falls back past a claude on PATH that does not run", async () => {
    // A shim whose interpreter has gone. Reporting it would send the sign-in to the one copy that
    // is guaranteed to fail.
    const broken = stubbed("exit 127");
    const p = await probeClaude(undefined, { env: { PATH: dirname(broken) }, bundled: carried(SIGNED_IN) });
    expect(p).toMatchObject({ available: true, version: "2.1.281 (Claude Code)" });
  });

  it("takes REALM_CLAUDE_BIN at its word, with no fallback behind it", async () => {
    // THE MUTANT: fall back past an override. The SDK spawns the override for every session, so the
    // probe would be reporting on a binary no session runs — and a stub meant to read as missing
    // (every suite that wants Claude absent) would read as installed.
    const env = { ...noPath(), REALM_CLAUDE_BIN: join(tmpdir(), "realm-no-such-claude") };
    expect((await probeClaude(undefined, { env, bundled: carried(SIGNED_IN) })).available).toBe(false);
  });

  it("does not tell a signed-out person to run a command their terminal does not have", async () => {
    const p = await probeClaude(undefined, { env: noPath(), bundled: carried(SIGNED_OUT) });
    expect(p.loggedIn).toBe(false);
    expect(p.reason).not.toContain("claude auth login");
    expect(p.reason).toContain("Realm");
  });

  it("is unavailable, and says why, when neither PATH nor Realm has one", async () => {
    const p = await probeClaude(undefined, { env: noPath(), bundled: () => null });
    expect(p).toMatchObject({ available: false, version: null, loggedIn: null });
    expect(p.reason).toContain("not on PATH");
  });
});

describe("claudeExecutable", () => {
  it("names the very binary the probe reports on: PATH's when it runs, else Realm's, else none", async () => {
    const own = stubbed(`echo "2.1.200 (Claude Code)"`);
    const realm = stubbed(`echo "2.1.281 (Claude Code)"`);
    const empty = tempDir("realm-probe-nopath-");
    expect(await claudeExecutable({ env: { PATH: dirname(own) }, bundled: () => realm })).toBe(own);
    expect(await claudeExecutable({ env: { PATH: empty }, bundled: () => realm })).toBe(realm);
    expect(await claudeExecutable({ env: { PATH: empty }, bundled: () => null })).toBeNull();
  });
});

describe("bundledClaude", () => {
  /* The one assertion the seams above cannot make: that the lookup finds the file the SDK itself
     spawns. A wrong package name here passes every injected test and returns null in production,
     which is exactly the "Claude isn't installed" this fallback exists to end. Located, never run.
     Skipped only where the SDK itself will not resolve, as the model-floor check is. */
  const sdkResolves = (() => { try { createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"); return true; } catch { return false; } })();

  it.skipIf(!sdkResolves)("resolves the SDK's own platform binary — the file every Claude session runs", () => {
    const bin = bundledClaude();
    expect(bin).not.toBeNull();
    expect(bin!.endsWith(`claude-agent-sdk-${process.platform}-${process.arch}${sep}claude`)).toBe(true);
    expect(existsSync(bin!)).toBe(true);
  });
});
