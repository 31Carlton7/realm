import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { AgentKind, AgentSignIn } from "@realm/contracts";
import { AgentSignInService, loginCommand, type LoginCommand } from "./signin-service";
import { waitFor } from "../test-utils";

/* What the real CLIs print, measured off the binaries rather than their docs. `claude auth login`
   (2.1.281) writes three lines in one breath — "Opening browser to sign in…", "If the browser didn't
   open, visit: <url>" with the URL wrapped in an OSC 8 hyperlink, and "Paste code here if prompted > "
   — then reads `code#state` lines from stdin. `codex login` (0.146.0) prints its own callback server
   first and the consent URL after it. The fakes below reproduce those shapes; nothing here ever runs
   a real login. */
const CONSENT = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=st4te";
const CODEX_CONSENT = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=st4te";

/**
 * A login program for one test: a real executable, run in a real pty, so what the service reads is
 * what a terminal would really have shown. It leaves its pid beside itself first, which is how a test
 * proves a process is gone rather than merely forgotten.
 */
function program(body: string): { command: LoginCommand; dir: string } {
  const dir = tempDir("realm-agentsignin-");
  const file = join(dir, "login");
  writeFileSync(file, `#!/bin/sh\necho $$ > "${dir}/pid"\n${body}\n`, { mode: 0o755 });
  return { command: { file, args: [] }, dir };
}

/** Prints the URL the way `claude auth login` does — OSC 8 around it — and stays. */
const SHOWS_PAGE = String.raw`
printf 'Opening browser to sign in…\n'
printf 'Docs: https://docs.claude.com/en/docs/claude-code\n'
printf 'If the browser did not open, visit: \033]8;;%s\007%s\033]8;;\007\n' '${CONSENT}' '${CONSENT}'
exec sleep 30`;

/** The whole of `claude auth login`'s happy path: the page, the prompt, a code read and kept. */
const TAKES_CODE = String.raw`
printf 'Opening browser to sign in…\n'
printf 'If the browser did not open, visit: \033]8;;%s\007%s\033]8;;\007\n' '${CONSENT}' '${CONSENT}'
printf 'Paste code here if prompted > '
read line
printf '%s' "$line" > "$(dirname "$0")/typed"
printf 'Login successful.\n'`;

/** Asks for a code and then sits — for the tests that type into a CLI that is waiting. */
const WAITS_FOR_CODE = String.raw`
printf 'If the browser did not open, visit: %s\n' '${CONSENT}'
printf 'Paste code here if prompted > '
exec sleep 30`;

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function pidOf(dir: string): Promise<number> {
  const f = join(dir, "pid");
  await waitFor(() => existsSync(f) && readFileSync(f, "utf8").trim() !== "");
  return Number(readFileSync(f, "utf8").trim());
}
/** The error a synchronous call threw, for asserting its code rather than only its text. */
function thrown(fn: () => void): unknown {
  try { fn(); } catch (e) { return e; }
  return null;
}

const services: AgentSignInService[] = [];
afterEach(() => { for (const s of services.splice(0)) s.disposeAll(); });

function harness(o: { login: (kind: AgentKind) => LoginCommand | null; loggedIn?: boolean | null; timeoutMs?: number }) {
  const said: AgentSignIn[] = [];
  const probed: AgentKind[] = [];
  const asked: AgentKind[] = [];
  const loggedIn = o.loggedIn === undefined ? true : o.loggedIn;
  const svc = new AgentSignInService({
    rpc: { broadcast: (event, payload) => { if (event === "agentSignIn.changed") said.push(payload as AgentSignIn); } },
    probe: async (kind) => {
      probed.push(kind);
      return { kind, available: true, version: null, loggedIn, reason: null };
    },
    command: async (kind) => { asked.push(kind); return o.login(kind); },
    cwd: tempDir("realm-agentsignin-cwd-"),
    timeoutMs: o.timeoutMs,
  });
  services.push(svc);
  const latest = (id: string) => [...said].reverse().find((s) => s.id === id);
  const reaches = (id: string, state: AgentSignIn["state"]) => waitFor(() => latest(id)?.state === state);
  return { svc, said, probed, asked, latest, reaches };
}

describe("a sign-in with no space around it", () => {
  it("answers at once, then reports the sign-in page the CLI printed — the consent link, not the docs one", async () => {
    const p = program(SHOWS_PAGE);
    const h = harness({ login: () => p.command });
    const first = await h.svc.start("claude");
    // Before the CLI has printed anything: the button gets its answer while the page is still coming.
    expect(first).toMatchObject({ kind: "claude", state: "starting", url: null, detail: null });
    await h.reaches(first.id, "browser");
    // Read off the RENDERED screen: the OSC 8 wrapper is invisible there, and the docs link printed
    // first is passed over for the one that is a consent URL.
    expect(h.latest(first.id)?.url).toBe(CONSENT);
  });

  it("asks for the code when the CLI does, types it with Return, and is done once a fresh probe of it agrees", async () => {
    const p = program(TAKES_CODE);
    const h = harness({ login: () => p.command });
    const { id } = await h.svc.start("claude");
    await h.reaches(id, "code");
    expect(h.latest(id)?.url).toBe(CONSENT);
    // A paste carries its line ending; what reaches the CLI is the code and one Return.
    h.svc.code(id, "  c0de-from-the-page#st4te\n");
    await h.reaches(id, "done");
    expect(readFileSync(join(p.dir, "typed"), "utf8")).toBe("c0de-from-the-page#st4te");
    // THE MUTANT: call a clean exit "done". Only a probe can say the CLI really holds a session — a
    // fresh one of this agent, not the cache's "not signed in" from before the login, and not every
    // agent's, which waits on the slowest adapter to say nothing about this one.
    expect(h.probed).toEqual(["claude"]);
    expect(JSON.stringify(h.said)).not.toContain("c0de-from-the-page");
  });

  it("fails with the CLI's own last words when it exits non-zero, kept to the end that says why", async () => {
    const p = program(String.raw`
i=1; while [ $i -le 8 ]; do echo "step $i"; i=$((i+1)); done
printf '%0600d\n' 0
echo 'Login failed: Request failed with status code 403' >&2
exit 1`);
    const h = harness({ login: () => p.command });
    const { id } = await h.svc.start("claude");
    await h.reaches(id, "failed");
    const detail = h.latest(id)?.detail ?? "";
    expect(detail).toContain("Login failed: Request failed with status code 403");
    // The last few lines, not the whole screen, and never more than a tooltip holds.
    expect(detail).not.toContain("step 1");
    expect(detail.length).toBeLessThanOrEqual(400);
    // A failed CLI is not a probe question — nothing here could have signed anyone in.
    expect(h.probed).toEqual([]);
  });

  it("never repeats a typed code in anything it reports, though the terminal echoed it", async () => {
    /* THE MUTANT: build `detail` from the raw screen. The tty echoes what Realm types, so the code
       is right there beside the prompt — and `detail` is broadcast to every window. */
    const p = program(String.raw`
printf 'Paste code here if prompted > '
read line
echo 'Invalid code. Please make sure the full code was copied.'
echo 'Login failed: invalid_grant'
exit 1`);
    const h = harness({ login: () => p.command });
    const { id } = await h.svc.start("claude");
    await h.reaches(id, "code");
    h.svc.code(id, "s3cret-c0de#st4te");
    await h.reaches(id, "failed");
    const detail = h.latest(id)?.detail ?? "";
    expect(detail).toContain("Login failed: invalid_grant");
    // Proof the echo was on screen to be cut — otherwise the assertion below passes for nothing.
    expect(detail).toContain("[code]");
    expect(JSON.stringify(h.said)).not.toContain("s3cret-c0de");
  });

  it("fails rather than claiming success when the CLI exits cleanly but the probe still says signed out", async () => {
    const p = program("echo 'Login successful.'");
    const h = harness({ login: () => p.command, loggedIn: false });
    const { id } = await h.svc.start("claude");
    await h.reaches(id, "failed");
    expect(h.latest(id)?.detail).toContain("isn't signed in");
  });

  it("does not offer the CLI's own callback server as the page to open", async () => {
    /* THE MUTANT: take `signInUrlOn`'s fallback as it comes. `codex login` prints
       `http://localhost:1455` a line before its consent URL, and a look between the two would make
       "Open the page again" a port that only serves the redirect. */
    const p = program(String.raw`
printf 'Starting local login server on http://localhost:1455.\n'
sleep 0.6
printf 'If your browser did not open, navigate to this URL to authenticate:\n\n%s\n' '${CODEX_CONSENT}'
exec sleep 30`);
    const h = harness({ login: () => p.command });
    const { id } = await h.svc.start("codex");
    await h.reaches(id, "browser");
    expect(h.latest(id)?.url).toBe(CODEX_CONSENT);
    expect(h.said.filter((s) => s.url !== null && !s.url.startsWith("https://"))).toEqual([]);
  });

  it("cancel stops the CLI and reports it cancelled, and a second cancel changes nothing", async () => {
    const p = program(SHOWS_PAGE);
    const h = harness({ login: () => p.command });
    const { id } = await h.svc.start("claude");
    const pid = await pidOf(p.dir);
    await h.reaches(id, "browser");
    h.svc.cancel(id);
    expect(h.latest(id)?.state).toBe("cancelled");
    // Gone, not merely forgotten: a CLI left running would finish a login nobody is waiting on.
    await waitFor(() => !alive(pid));
    const heard = h.said.length;
    h.svc.cancel(id);
    expect(h.said.length).toBe(heard);
    expect(thrown(() => h.svc.code(id, "abc#def"))).toMatchObject({ code: "SIGN_IN_FINISHED" });
  });

  it("replaces a sign-in for the same agent, reporting the first cancelled and stopping it", async () => {
    const a = program(SHOWS_PAGE);
    const b = program(SHOWS_PAGE);
    const queue = [a.command, b.command];
    const h = harness({ login: () => queue.shift() ?? null });
    const first = await h.svc.start("claude");
    const pidA = await pidOf(a.dir);
    const second = await h.svc.start("claude");
    expect(h.latest(first.id)?.state).toBe("cancelled");
    await waitFor(() => !alive(pidA));
    // THE MUTANT: replace by stopping everything. The new one is the one the person is looking at.
    const pidB = await pidOf(b.dir);
    expect(alive(pidB)).toBe(true);
    expect(h.latest(second.id)?.state).not.toBe("cancelled");
  });

  it("leaves another agent's sign-in alone — one live sign-in per agent, not one in all", async () => {
    const a = program(SHOWS_PAGE);
    const b = program(SHOWS_PAGE);
    const h = harness({ login: (kind) => (kind === "claude" ? a.command : b.command) });
    const claude = await h.svc.start("claude");
    await h.svc.start("codex");
    const [pidA, pidB] = await Promise.all([pidOf(a.dir), pidOf(b.dir)]);
    expect(h.latest(claude.id)?.state).not.toBe("cancelled");
    expect(alive(pidA) && alive(pidB)).toBe(true);
  });

  it("types only into a sign-in that is asking, and only a code with nothing hidden in it", async () => {
    const h = harness({ login: () => program(SHOWS_PAGE).command });
    expect(thrown(() => h.svc.code("01JNOSUCHSIGNIN000000000000", "abc#def"))).toMatchObject({ code: "NOT_FOUND" });
    const showing = await h.svc.start("claude");
    await h.reaches(showing.id, "browser");
    // Still printing, not asking: a code typed now would land in whatever it reads next.
    expect(thrown(() => h.svc.code(showing.id, "abc#def"))).toMatchObject({ code: "SIGN_IN_NOT_ASKING" });

    const waiting = program(WAITS_FOR_CODE);
    const h2 = harness({ login: () => waiting.command });
    const asking = await h2.svc.start("codex");
    const pid = await pidOf(waiting.dir);
    await h2.reaches(asking.id, "code");
    // THE MUTANT: type whatever arrives. In a pty `\x03` is a SIGINT, and it would kill the CLI.
    expect(thrown(() => h2.svc.code(asking.id, "abc\u0003def"))).toMatchObject({ code: "BAD_REQUEST" });
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pid)).toBe(true);
    expect(h2.latest(asking.id)?.state).toBe("code");
  });

  it("refuses an agent with no sign-in command, and never looks for anything to spawn", async () => {
    const h = harness({ login: () => program(SHOWS_PAGE).command });
    await expect(h.svc.start("acp:gemini")).rejects.toThrow(/API key/);
    expect(h.asked).toEqual([]);
    expect(h.said).toEqual([]);
  });

  it("refuses an agent whose CLI is not on this Mac, before announcing anything", async () => {
    const h = harness({ login: () => null });
    await expect(h.svc.start("codex")).rejects.toMatchObject({ code: "CLI_NOT_INSTALLED" });
    expect(h.said).toEqual([]);
  });

  it("ends a sign-in that runs past its deadline, says so, and stops the CLI", async () => {
    const p = program(SHOWS_PAGE);
    const h = harness({ login: () => p.command, timeoutMs: 400 });
    const { id } = await h.svc.start("claude");
    const pid = await pidOf(p.dir);
    await h.reaches(id, "failed");
    expect(h.latest(id)?.detail).toMatch(/timed out/);
    await waitFor(() => !alive(pid));
  });

  it("stops every live sign-in when the server shuts down, and says it did not finish", async () => {
    const p = program(SHOWS_PAGE);
    const h = harness({ login: () => p.command });
    const { id } = await h.svc.start("claude");
    const pid = await pidOf(p.dir);
    h.svc.disposeAll();
    expect(h.latest(id)).toMatchObject({ state: "failed", detail: expect.stringContaining("Realm closed") });
    await waitFor(() => !alive(pid));
  });
});

describe("loginCommand", () => {
  /** An executable that answers anything — `--version` included, which is how the Claude lookup
   *  decides a copy runs. */
  function bin(dir: string, name: string): string {
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
    return file;
  }

  it("runs each CLI's own subcommand from the table, on the binary found on PATH", async () => {
    const dir = tempDir("realm-loginbin-");
    const claude = bin(dir, "claude");
    const codex = bin(dir, "codex");
    expect(await loginCommand("claude", { PATH: dir })).toEqual({ file: claude, args: ["auth", "login"] });
    expect(await loginCommand("codex", { PATH: dir })).toEqual({ file: codex, args: ["login"] });
  });

  it("follows REALM_CLAUDE_BIN and REALM_CODEX_BIN, which is how a live check reaches a stub", async () => {
    const real = tempDir("realm-loginbin-");
    bin(real, "claude");
    bin(real, "codex");
    const stubs = tempDir("realm-loginstub-");
    const env = { PATH: real, REALM_CLAUDE_BIN: bin(stubs, "claude-stub"), REALM_CODEX_BIN: bin(stubs, "codex-stub") };
    expect(await loginCommand("claude", env)).toEqual({ file: env.REALM_CLAUDE_BIN, args: ["auth", "login"] });
    expect(await loginCommand("codex", env)).toEqual({ file: env.REALM_CODEX_BIN, args: ["login"] });
  });

  it("refuses an override that does not resolve rather than falling back to the CLI on PATH", async () => {
    // THE MUTANT: fall back to PATH. A live check whose stub went missing would start a real login
    // on the account of whoever is running it.
    const real = tempDir("realm-loginbin-");
    bin(real, "claude");
    bin(real, "codex");
    const env = { PATH: real, REALM_CLAUDE_BIN: join(real, "gone-claude"), REALM_CODEX_BIN: join(real, "gone-codex") };
    expect(await loginCommand("claude", env)).toBeNull();
    expect(await loginCommand("codex", env)).toBeNull();
  });

  it("has nothing to run for an agent with no login command, or one that is not installed", async () => {
    const empty = tempDir("realm-loginbin-");
    expect(await loginCommand("acp:gemini", { PATH: empty })).toBeNull();
    expect(await loginCommand("codex", { PATH: empty })).toBeNull();
  });
});
