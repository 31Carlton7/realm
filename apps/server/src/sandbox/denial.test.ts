import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecutionSandboxPolicy } from "@realm/contracts";
import { probeSandboxExec } from "./service";
import { sandboxCommand } from "./spawn";

/**
 * The tests that are worth having: a REAL `sandbox-exec` process, and a DENIAL proved by running the
 * forbidden thing and watching it fail.
 *
 * A test that shows the allowed path working proves nothing about a sandbox — an empty profile
 * passes it. Every case below is therefore paired: the same operation, inside and outside the
 * boundary, in one test, so a policy that stopped confining anything cannot go green by allowing
 * both. The compiler's unit tests assert on text; these assert on the kernel.
 *
 * ## Skipping, and why skipping here is not the same as skipping elsewhere
 *
 * Off macOS there is nothing to run and these skip, in the shape `live-graphify-check.ts` uses for
 * an absent `graphify`. ON macOS a missing or non-functional `sandbox-exec` is NOT a skip — it is
 * the finding this whole feature is about, so `the mechanism is available at all` fails and takes
 * the suite red. A security test that goes quiet on the machine where it could not run is the lie
 * the honesty rule forbids, and a yellow dot in a scrollback is quiet enough to miss.
 *
 * Every process here is `/usr/bin/touch`, `/bin/cat` or this suite's own `node`, with a deadline,
 * under a temp directory. Nothing reaches the real `~/Realm`.
 */

const DARWIN = process.platform === "darwin";
const probe = DARWIN ? probeSandboxExec("darwin") : { available: false, error: "unsupported_platform" as const, detail: `not macOS (${process.platform})` };
const live = probe.available ? it : it.skip;
if (!probe.available) console.warn(`[sandbox] live denial tests SKIPPED — ${probe.detail}`);

/** Realpath'd: Seatbelt matches what the kernel resolved, and $TMPDIR is under a symlink. */
const root = realpathSync(tempDir("realm-sandbox-denial-"));
const workspace = join(root, "workspace");
const outside = join(root, "outside");
const secrets = join(root, "secrets");
for (const d of [workspace, outside, secrets]) mkdirSync(d, { recursive: true });
writeFileSync(join(secrets, "id_ed25519"), "PRIVATE-KEY-CONTENTS");
writeFileSync(join(outside, "readable.txt"), "ORDINARY-FILE");

const policy = (o: Partial<ExecutionSandboxPolicy> = {}): ExecutionSandboxPolicy => ({
  posture: "workspace-write",
  writableRoots: [workspace],
  readableRoots: [],
  readOnlyPaths: [],
  protectedRoots: [secrets],
  network: false,
  ...o,
});

type Run = { status: number | null; stdout: string; stderr: string };

/** Run `argv` through the real wrapper and the real `sandbox-exec`. */
function sandboxed(p: ExecutionSandboxPolicy, command: string, args: string[]): Run {
  const cmd = sandboxCommand({ command, args, policy: p });
  const r = spawnSync(cmd.command, cmd.args, { encoding: "utf8", timeout: 20_000 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("the mechanism", () => {
  it("is available at all", () => {
    // Deliberately NOT skipped on macOS. See the header: an absent sandbox-exec on a Mac is the
    // finding, not an excuse to report nothing.
    if (!DARWIN) { expect(probe.error).toBe("unsupported_platform"); return; }
    expect(probe.available, `sandbox-exec did not work on this Mac: ${probe.detail}`).toBe(true);
  });
});

describe("filesystem writes", () => {
  live("allows a write inside the workspace and denies the identical write outside it", () => {
    const inside = sandboxed(policy(), "/usr/bin/touch", [join(workspace, "allowed.txt")]);
    expect(inside.status, inside.stderr).toBe(0);
    expect(existsSync(join(workspace, "allowed.txt"))).toBe(true);

    const out = sandboxed(policy(), "/usr/bin/touch", [join(outside, "denied.txt")]);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/Operation not permitted/);
    expect(existsSync(join(outside, "denied.txt"))).toBe(false);
  });

  live("denies a write to the user's real home directory", () => {
    /* The concrete thing this feature exists to stop: a process planting a file in $HOME. This is
       the one test that names a path outside the temp root, because a denial proved only against a
       directory the test made is a weaker claim than one proved against the place that matters.
       Cleaned BEFORE rather than after: if a broken sandbox ever lets the touch through, the file it
       left must not be able to fail every later run — but the evidence should survive the run that
       found it. */
    const target = join(process.env.HOME ?? "/Users/nobody", ".realm-sandbox-must-not-exist");
    rmSync(target, { force: true });
    const r = sandboxed(policy(), "/usr/bin/touch", [target]);
    expect(r.status).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  live("denies a write to a PROTECTED path even when it sits inside a writable root", () => {
    // The ordering claim from the compiler, proved against the kernel: `protectedRoots` is emitted
    // last and SBPL's last matching rule wins, so this write loses to the deny even though the
    // enclosing directory is allowed.
    const nested = join(workspace, "nested-secrets");
    mkdirSync(nested, { recursive: true });
    const p = policy({ protectedRoots: [nested] });
    expect(sandboxed(p, "/usr/bin/touch", [join(nested, "x")]).status).not.toBe(0);
    expect(existsSync(join(nested, "x"))).toBe(false);
    // …and the same write one directory up still works, so the deny is narrow rather than total.
    expect(sandboxed(p, "/usr/bin/touch", [join(workspace, "sibling")]).status).toBe(0);
  });

  live("denies a write to a read-only path inside a writable root while still allowing the read", () => {
    /* The `~/.claude/settings.json` case, which is the reason `readOnlyPaths` exists as a third list
       rather than being folded into `protectedRoots`: the CLI's own state directory has to be
       writable for it to run at all, and the one file in it that can make something EXECUTE has to
       stay readable and unwritable. Both halves are asserted, because either alone is satisfiable by
       a rule that is wrong. */
    const settings = join(workspace, "settings.json");
    writeFileSync(settings, '{"hooks":[]}');
    const p = policy({ readOnlyPaths: [settings] });

    const write = sandboxed(p, "/bin/sh", ["-c", `echo pwned > ${JSON.stringify(settings)}`]);
    expect(write.status).not.toBe(0);
    expect(readFileSync(settings, "utf8")).toBe('{"hooks":[]}');

    const read = sandboxed(p, "/bin/cat", [settings]);
    expect(read.status, read.stderr).toBe(0);
    expect(read.stdout).toBe('{"hooks":[]}');

    // …and the directory around it is still writable, or the CLI could not write a transcript.
    expect(sandboxed(p, "/usr/bin/touch", [join(workspace, "transcript.jsonl")]).status).toBe(0);
  });

  live("keeps denying after the process re-execs itself twice", () => {
    // Seatbelt is inherited across exec. A shell that runs a script that runs a compiler is all one
    // sandbox, and that is the claim that makes wrapping the SPAWN sufficient.
    const r = sandboxed(policy(), "/bin/sh", ["-c", `exec /bin/sh -c "exec /usr/bin/touch ${join(outside, "grandchild.txt")}"`]);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(outside, "grandchild.txt"))).toBe(false);
  });

  live("denies everything but the temp root under read-only", () => {
    const ro = policy({ posture: "read-only", writableRoots: [root] });
    expect(sandboxed(ro, "/usr/bin/touch", [join(root, "tmp-ok.txt")]).status).toBe(0);
    const p = policy({ posture: "read-only", writableRoots: [join(root, "nothing-here")] });
    expect(sandboxed(p, "/usr/bin/touch", [join(workspace, "ro-denied.txt")]).status).not.toBe(0);
    expect(existsSync(join(workspace, "ro-denied.txt"))).toBe(false);
  });
});

describe("filesystem reads", () => {
  live("denies reading a protected file and allows reading an ordinary one", () => {
    const denied = sandboxed(policy(), "/bin/cat", [join(secrets, "id_ed25519")]);
    expect(denied.status).not.toBe(0);
    expect(denied.stdout).not.toContain("PRIVATE-KEY-CONTENTS");
    expect(denied.stderr).toMatch(/Operation not permitted/);

    const allowed = sandboxed(policy(), "/bin/cat", [join(outside, "readable.txt")]);
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stdout).toBe("ORDINARY-FILE");
  });

  live("denies a read that goes through a symlink into a protected directory", () => {
    // Seatbelt resolves the path before it matches, so the obvious dodge does not work. The
    // NON-obvious one — a hard link that already exists at an unprotected path — DOES, and is
    // documented in execution-sandbox.ts rather than papered over here.
    const link = join(workspace, "link-to-secrets");
    if (!existsSync(link)) spawnSync("/bin/ln", ["-s", secrets, link]);
    const r = sandboxed(policy(), "/bin/cat", [join(link, "id_ed25519")]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("PRIVATE-KEY-CONTENTS");
  });

  live("denies listing a protected directory, not just reading files in it", () => {
    const r = sandboxed(policy(), "/bin/ls", [secrets]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("id_ed25519");
  });
});

describe("a hostile path cannot widen the sandbox", () => {
  /*
   * The compiler's unit test proves the profile TEXT is unchanged by an injection attempt. This
   * proves the kernel agrees: a writable root whose name is itself a fragment of SBPL grants that
   * directory and nothing else.
   */
  const attacks = [
    '") (allow file-write* (subpath "/private',
    '"))\n(allow file-write* (subpath "/private',
    "close)paren",
    'quote"inside',
  ];

  for (const name of attacks) {
    live(`treats ${JSON.stringify(name.slice(0, 24))} as a directory name, not as policy`, () => {
      const dir = join(workspace, name);
      mkdirSync(dir, { recursive: true });
      const p = policy({ writableRoots: [dir] });
      // The hostile directory itself is writable, because that is what was asked for…
      expect(sandboxed(p, "/usr/bin/touch", [join(dir, "in.txt")]).status).toBe(0);
      // …and nothing the injection tried to add is.
      expect(sandboxed(p, "/usr/bin/touch", [join(outside, "widened.txt")]).status).not.toBe(0);
      expect(sandboxed(p, "/usr/bin/touch", [join(workspace, "widened2.txt")]).status).not.toBe(0);
      expect(existsSync(join(outside, "widened.txt"))).toBe(false);
    });
  }
});

describe("an unresolved root grants nothing", () => {
  live("matches nothing when the writable root is given through a symlink", () => {
    /* The failure mode the whole `realpath` discipline exists for, demonstrated rather than
       described: `/tmp` is a symlink to `/private/tmp`, so a policy naming the symlink allows no
       writes at all. Harmless for a writable root (too tight); fatal for a protected one (too
       loose), which is why `resolveExecutionSandboxPolicy` emits protected roots both ways. */
    const target = join(root, "real-target");
    const link = join(root, "symlinked-root");
    mkdirSync(target, { recursive: true });
    if (!existsSync(link)) spawnSync("/bin/ln", ["-s", target, link]);
    const p = policy({ writableRoots: [link] });
    expect(sandboxed(p, "/usr/bin/touch", [join(link, "nope.txt")]).status).not.toBe(0);
    expect(existsSync(join(target, "nope.txt"))).toBe(false);
    // Named by its real path, the same write succeeds.
    expect(sandboxed(policy({ writableRoots: [target] }), "/usr/bin/touch", [join(target, "yes.txt")]).status).toBe(0);
  });
});

describe("network", () => {
  /*
   * A loopback listener this test owns, so the check is offline, deterministic and has no dependency
   * on what the machine can reach. `connect` against it answers in one of exactly two ways: EPERM
   * when the policy denies the network, and a completed connection when it allows it.
   */
  let port = 0;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    server = createServer((s) => s.end("hello"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  const connectProbe = (p: number): string =>
    `const net=require("node:net");const s=net.connect(${p},"127.0.0.1");s.setTimeout(5000);` +
    `s.on("connect",()=>{console.log("CONNECTED");s.destroy();process.exit(0)});` +
    `s.on("timeout",()=>{console.log("TIMEOUT");process.exit(2)});` +
    `s.on("error",(e)=>{console.log("ERR "+e.code);process.exit(3)});`;

  live("refuses an outbound connection when the policy says no network", () => {
    const r = sandboxed(policy({ network: false }), process.execPath, ["-e", connectProbe(port)]);
    expect(r.stdout.trim()).toBe("ERR EPERM");
    expect(r.status).toBe(3);
  });

  live("allows the identical connection when the policy says network", () => {
    const r = sandboxed(policy({ network: true }), process.execPath, ["-e", connectProbe(port)]);
    expect(r.stdout.trim(), r.stderr).toBe("CONNECTED");
    expect(r.status).toBe(0);
  });

  live("refuses to LISTEN as well as to connect when the policy says no network", () => {
    // A denied outbound with an allowed bind would let a sandboxed process serve the machine.
    const bind = `const net=require("node:net");const s=net.createServer();` +
      `s.on("error",(e)=>{console.log("BIND_ERR "+e.code);process.exit(3)});` +
      `s.listen(0,"127.0.0.1",()=>{console.log("BOUND");s.close();process.exit(0)});`;
    const r = sandboxed(policy({ network: false }), process.execPath, ["-e", bind]);
    expect(r.stdout.trim()).toBe("BIND_ERR EPERM");
  });
});

describe("escalation", () => {
  live("refuses to exec a setuid binary", () => {
    // Not a rule Realm wrote — Seatbelt refuses setuid/setgid exec on its own. Asserted because it
    // is a property the feature is described as having, and because it is the reason `ps` and `top`
    // stop working in a sandboxed terminal. If a macOS release changes it, this says so.
    const r = sandboxed(policy(), "/bin/ps", ["-o", "pid="]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Operation not permitted/);
  });

  live("cannot create a hard link out of a protected directory", () => {
    // The documented weakness is a hard link that ALREADY exists. Making one from inside is refused,
    // because `link()` needs metadata on the source and the source is unreadable.
    const r = sandboxed(policy(), "/bin/ln", [join(secrets, "id_ed25519"), join(workspace, "stolen")]);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(workspace, "stolen"))).toBe(false);
  });
});
