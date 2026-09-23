import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { probeClaude } from "./probe";

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
