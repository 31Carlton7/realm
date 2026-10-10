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
/**
 * And no `CLAUDE_CONFIG_DIR` of the developer's own. The fallback reads the folder that variable
 * names ahead of the home folder's, so a shell that keeps its Claude login in a folder of its own
 * would send every test about the fallback to that folder's credentials.
 */
let prevDir: string | undefined;
beforeEach(() => {
  prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  prevHome = process.env.HOME;
  process.env.HOME = tempDir("realm-probe-home-");
  prevDir = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevDir;
});

/** A CLI that answers `auth status` with exactly this JSON. The tests about a config folder are
 *  about what is read out of that one answer, and what is put beside it. */
const answering = (status: string): string => stubbed(`
  case "$1" in
    --version) echo "2.1.296 (Claude Code)" ;;
    auth) echo '${status}' ;;
  esac`);

/** A CLI from before `auth status` existed, so every question about a sign-in lands on the fallback. */
const withoutAuthStatus = (): string => stubbed(`
  case "$1" in
    --version) echo "1.0.0" ;;
    *) exit 1 ;;
  esac`);

/** A signed-out CLI that states the config folder it was started under, as the real one does. What
 *  it prints is the one place a test can see which environment the question was asked in. */
const statingItsFolder = (): string => stubbed(`
  case "$1" in
    --version) echo "2.1.296 (Claude Code)" ;;
    auth) printf '{"loggedIn":false,"configDirectory":"%s"}\\n' "$CLAUDE_CONFIG_DIR" ;;
  esac`);

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

  it("passes on the account a signed-in CLI names, as it spells it", async () => {
    const bin = stubbed(`
      case "$1" in
        --version) echo "2.1.281 (Claude Code)" ;;
        auth) echo '{"loggedIn":true,"authMethod":"claude.ai","email":" owner@example.com ","orgName":"Example Labs","subscriptionType":"max"}' ;;
      esac`);
    expect(await probeClaude(bin)).toEqual({ available: true, version: "2.1.281 (Claude Code)", loggedIn: true, reason: null,
      account: { email: "owner@example.com", organization: "Example Labs", plan: "max" } });
  });

  it("names the account with whatever else the CLI left out as unknown", async () => {
    const bin = stubbed(`
      case "$1" in
        --version) echo "2.1.281" ;;
        auth) echo '{"loggedIn":true,"email":"owner@example.com","orgName":"","subscriptionType":7}' ;;
      esac`);
    expect((await probeClaude(bin)).account).toEqual({ email: "owner@example.com", organization: null, plan: null });
  });

  it("reports no account for a sign-in that carries no email, or for a CLI that is signed out", async () => {
    for (const status of ['{"loggedIn":true,"authMethod":"api_key","subscriptionType":"max"}', '{"loggedIn":true,"email":"   "}', '{"loggedIn":false,"email":"owner@example.com"}']) {
      const bin = stubbed(`
        case "$1" in
          --version) echo "2.1.281" ;;
          auth) echo '${status}' ;;
        esac`);
      expect(await probeClaude(bin), status).not.toHaveProperty("account");
    }
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

describe("probing one Claude config folder", () => {
  const WORK = "/Users/mara/.claude-work";
  const PERSONAL = "/Users/mara/.claude-personal";
  const SIGNED_OUT_THERE = `{"loggedIn":false,"authMethod":"none","configDirectory":"${WORK}"}`;

  it("asks the CLI under the environment it was handed, so the answer is about the folder that environment names", async () => {
    const folder = tempDir("realm-probe-folder-");
    expect((await probeClaude(statingItsFolder(), { env: { CLAUDE_CONFIG_DIR: folder } })).configDirectory).toBe(folder);
  });

  it("passes on the folder a signed-in CLI says it answered for, exactly as the CLI spells it", async () => {
    const spelled = "/Users/mara/Claude work ";
    const p = await probeClaude(answering(`{"loggedIn":true,"configDirectory":"${spelled}"}`));
    expect(p.loggedIn).toBe(true);
    expect(p.configDirectory).toBe(spelled);
  });

  it("passes it on from a signed-out CLI, the answer a folder's sign-in card is drawn from", async () => {
    expect(await probeClaude(answering(SIGNED_OUT_THERE))).toMatchObject({ loggedIn: false, configDirectory: WORK });
  });

  it("passes it on from Realm's own copy when that copy is signed out", async () => {
    const carried = answering(SIGNED_OUT_THERE);
    expect(await probeClaude(undefined, { env: { PATH: tempDir("realm-probe-nopath-") }, bundled: () => carried }))
      .toMatchObject({ loggedIn: false, reason: expect.stringContaining("sign in from Realm"), configDirectory: WORK });
  });

  it("passes it on from an answer that carries no verdict", async () => {
    expect(await probeClaude(answering(`{"authMethod":"claude.ai","configDirectory":"${WORK}"}`)))
      .toMatchObject({ loggedIn: null, configDirectory: WORK });
  });

  it("passes on the folder that answered when it is not the one the caller named, since only then can a caller tell another folder's account from this one's", async () => {
    const p = await probeClaude(answering(`{"loggedIn":true,"email":"owner@example.com","configDirectory":"${PERSONAL}"}`), { env: { CLAUDE_CONFIG_DIR: WORK }, configDir: WORK });
    expect(p.configDirectory).toBe(PERSONAL);
  });

  it("reports no folder where the CLI states none, a blank one, or something that is not a path, and never fills in the folder it was asked about", async () => {
    for (const status of ['{"loggedIn":true}', '{"loggedIn":true,"configDirectory":""}', '{"loggedIn":false,"configDirectory":"   "}', '{"loggedIn":true,"configDirectory":7}']) {
      expect(await probeClaude(answering(status), { env: { CLAUDE_CONFIG_DIR: WORK }, configDir: WORK }), status).not.toHaveProperty("configDirectory");
    }
  });

  it("offers a signed-out folder the command that signs in the folder the caller named, whichever folder the CLI states", async () => {
    for (const status of ['{"loggedIn":false}', `{"loggedIn":false,"configDirectory":"${PERSONAL}"}`]) {
      const p = await probeClaude(answering(status), { configDir: WORK });
      expect(p.reason, status).toBe("not signed in — run `env CLAUDE_CONFIG_DIR='/Users/mara/.claude-work' claude auth login`");
    }
  });

  it("offers the plain command, word for word, for a folder the caller did not name, though the environment and the CLI both carry one", async () => {
    const p = await probeClaude(answering(SIGNED_OUT_THERE), { env: { CLAUDE_CONFIG_DIR: WORK } });
    expect(p.reason).toBe("not signed in — run `claude auth login`");
  });

  it("goes on telling a signed-out person to sign in from Realm when the copy is the one Realm carries, whichever folder the caller named", async () => {
    const carried = answering('{"loggedIn":false}');
    const p = await probeClaude(undefined, { env: { PATH: tempDir("realm-probe-nopath-") }, bundled: () => carried, configDir: WORK });
    expect(p.reason).toBe("not signed in — sign in from Realm: this is the Claude Code that comes with Realm, so there is no `claude` command to run in a terminal");
  });

  it("looks for an old CLI's credentials file in the folder it was asked under", async () => {
    const folder = tempDir("realm-probe-folder-");
    writeFileSync(join(folder, ".credentials.json"), "{}");
    expect((await probeClaude(withoutAuthStatus(), { env: { CLAUDE_CONFIG_DIR: folder } })).loggedIn).toBe(true);
  });

  it("keeps a folder's sign-in apart from the default one's when it has only a file to go on", async () => {
    mkdirSync(join(process.env.HOME!, ".claude"));
    writeFileSync(join(process.env.HOME!, ".claude", ".credentials.json"), "{}");
    const folder = tempDir("realm-probe-folder-");
    expect((await probeClaude(withoutAuthStatus(), { env: { CLAUDE_CONFIG_DIR: folder } })).loggedIn).toBeNull();
  });

  it("states no folder for an answer the CLI never gave, whether or not the file check finds a sign-in", async () => {
    const signedIn = tempDir("realm-probe-folder-");
    writeFileSync(join(signedIn, ".credentials.json"), "{}");
    const bin = withoutAuthStatus();
    for (const folder of [signedIn, tempDir("realm-probe-folder-")]) {
      expect(await probeClaude(bin, { env: { CLAUDE_CONFIG_DIR: folder }, configDir: folder }), folder).not.toHaveProperty("configDirectory");
    }
  });

  it("goes on reading the default folder's file where the environment names no folder, or a blank one", async () => {
    mkdirSync(join(process.env.HOME!, ".claude"));
    writeFileSync(join(process.env.HOME!, ".claude", ".credentials.json"), "{}");
    const bin = withoutAuthStatus();
    for (const lookup of [undefined, { env: {} }, { env: { CLAUDE_CONFIG_DIR: "" } }]) {
      expect((await probeClaude(bin, lookup)).loggedIn, JSON.stringify(lookup)).toBe(true);
    }
  });

  it("takes an API key for a sign-in from the environment it was asked under, whichever folder that names, and from no other", async () => {
    const bin = withoutAuthStatus();
    for (const env of [{ ANTHROPIC_API_KEY: "sk-test" }, { ANTHROPIC_API_KEY: "sk-test", CLAUDE_CONFIG_DIR: tempDir("realm-probe-folder-") }]) {
      expect((await probeClaude(bin, { env })).loggedIn, Object.keys(env).join()).toBe(true);
    }
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect((await probeClaude(bin, { env: {} })).loggedIn).toBeNull();
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
