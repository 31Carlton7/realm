/**
 * Live check of the execution sandbox against the REAL toolchain on this Mac.
 *
 * `denial.test.ts` proves the boundary holds, with `/usr/bin/touch` and `/bin/cat`. It cannot answer
 * the other half of the question, which is the one that decides whether this feature is shippable:
 * **does a real agent's real work still run inside it?** A policy that denies everything passes every
 * denial test and makes Realm useless, and the difference only shows up when something big and
 * uncooperative — a login `zsh` that sources the user's dotfiles, a `git commit`, an `npm` that wants
 * its cache — is put through it.
 *
 * So this runs the real binaries under the real resolved policy for a scratch space, and reports:
 *
 *   1. the toolchain runs at all (node, git, npm, and a LOGIN zsh, which is what terminals spawn);
 *   2. a `git init` + `git commit` completes in a sandboxed checkout — the case that first exposed
 *      `/dev/null` needing an explicit allow;
 *   3. the profile fits in the argv (macOS ARG_MAX is 1 MiB and the whole profile rides on `-p`);
 *   4. the denials that matter still bite against the REAL home directory: no write to `$HOME`, no
 *      read of `~/.ssh` — against the user's own paths rather than a fixture's;
 *   5. which toolchain caches on THIS machine are missing, since a cache that is absent is one the
 *      first sandboxed install has to create.
 *
 * It writes only inside its own scratch directories. It never touches the real `~/Realm`, and the
 * `$HOME` write it attempts is expected to FAIL — if it succeeds that is the headline result.
 *
 *   pnpm --filter @realm/server exec tsx src/sandbox/live-sandbox-check.ts
 *
 * Exits non-zero if any check fails. An absent `sandbox-exec` is reported as a SKIP, not a pass.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOOLCHAIN_CACHE_DIRS,
  describeExecutionSandbox,
  type ExecutionSandboxPolicy,
} from "@realm/contracts";
import { finish, ok } from "../../scripts/harness";
import { realRoot, resolveExecutionSandboxPolicy } from "./policy";
import { probeSandboxExec } from "./service";
import { sandboxCommand } from "./spawn";

const TIMEOUT_MS = 60_000;

function run(policy: ExecutionSandboxPolicy, command: string, args: string[], cwd?: string) {
  const cmd = sandboxCommand({ command, args, policy });
  const r = spawnSync(cmd.command, cmd.args, { encoding: "utf8", timeout: TIMEOUT_MS, cwd });
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function main(): never {
  const probe = probeSandboxExec();
  if (!probe.available) {
    console.log(`  SKIP  the sandbox cannot be applied on this machine — ${probe.detail}`);
    console.log("        Realm's postures other than `off` would refuse to start sessions here.");
    finish();
  }
  ok("sandbox-exec applies a trivial profile", probe.available, probe.detail);

  const scratch = mkdtempSync(join(tmpdir(), "realm-sandbox-live-"));
  const checkout = join(scratch, "checkout");
  const realmHome = join(scratch, "Realm");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(realmHome, { recursive: true });

  try {
    // The REAL home, on purpose: the point is to exercise this user's actual dotfiles, actual
    // toolchain caches and actual ~/.ssh, none of which a fixture home has.
    const home = homedir();
    const policy = resolveExecutionSandboxPolicy({
      prefs: { posture: "workspace-write", network: true },
      checkouts: [realpathSync(checkout)],
      home, tmpDir: tmpdir(), realmHome,
      onDrop: (root, why) => console.log(`  note  dropped root ${root} — ${why}`),
    });
    console.log(`\n  ${describeExecutionSandbox(policy)}`);
    console.log(`  ${policy.writableRoots.length} writable roots, ${policy.protectedRoots.length} protected paths\n`);

    // ── 3. the profile has to fit in the argv ────────────────────────────────────────────────
    const argv = sandboxCommand({ command: "/usr/bin/true", args: [], policy });
    const argvBytes = argv.args.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0);
    ok("the compiled argv is comfortably inside ARG_MAX", argvBytes < 200_000, `${argvBytes} bytes (ARG_MAX is 1 MiB)`);

    // ── 1. the toolchain runs ────────────────────────────────────────────────────────────────
    for (const [label, command, args] of [
      ["node", "/usr/bin/env", ["node", "--version"]],
      ["git", "/usr/bin/env", ["git", "--version"]],
      ["npm", "/usr/bin/env", ["npm", "--version"]],
      // A LOGIN shell, because that is what TerminalManager spawns (`-l`) and it is the thing most
      // likely to trip over a denial — it sources /etc/zprofile, the user's rc files and whatever
      // prompt framework they installed.
      ["a login zsh", "/bin/zsh", ["-lc", "echo shell-ok"]],
    ] as const) {
      const r = run(policy, command, [...args], checkout);
      ok(`${label} runs sandboxed`, r.status === 0, r.status === 0 ? r.stdout.split("\n").at(-1) ?? "" : `exit ${r.status}: ${r.stderr.slice(0, 200)}`);
    }

    // ── 2. a real git commit in a sandboxed checkout ─────────────────────────────────────────
    const gitScript = "git init -q . && echo hello > file.txt && git add file.txt && " +
      "git -c user.email=live@realm -c user.name=Live commit -qm 'sandboxed commit' && git log --oneline | head -1";
    const git = run(policy, "/bin/sh", ["-c", gitScript], checkout);
    ok("git init + add + commit completes inside the sandbox", git.status === 0, git.status === 0 ? git.stdout : git.stderr.slice(0, 300));

    // ── the agent CLIs themselves ────────────────────────────────────────────────────────────
    /*
     * The question a unit test cannot ask: does the thing Realm actually spawns still start?
     *
     * Each one is measured AGAINST ITSELF — the same command unsandboxed first, as a control. That
     * is not ceremony: `opencode --version` hangs forever when stdout is a pipe, with or without a
     * sandbox, and without the control this check would report a sandbox failure for a CLI that
     * behaves the same way outside one. A difference between the two runs is a finding; a CLI that
     * fails both ways is a note about the CLI.
     */
    for (const bin of ["claude", "codex", "cursor-agent", "gemini", "opencode", "copilot", "goose"]) {
      const found = spawnSync("/bin/zsh", ["-lc", `command -v ${bin}`], { encoding: "utf8", timeout: 20_000 });
      if (found.status !== 0) { console.log(`  skip  ${bin} is not installed on this machine`); continue; }
      const control = spawnSync("/bin/zsh", ["-lc", `${bin} --version`], { encoding: "utf8", timeout: 20_000 });
      if (control.status !== 0) {
        console.log(`  note  ${bin} does not answer \`--version\` on this machine even unsandboxed; nothing to compare against`);
        continue;
      }
      const r = run(policy, "/bin/zsh", ["-lc", `${bin} --version`], checkout);
      ok(`${bin} starts sandboxed`, r.status === 0, r.status === 0 ? r.stdout.split("\n").at(-1) ?? "" : `exit ${r.status} (it exits 0 unsandboxed): ${r.stderr.slice(0, 200)}`);
    }

    // ── 4. the denials, against this user's real paths ───────────────────────────────────────
    const homeTarget = join(home, ".realm-sandbox-live-check-must-not-exist");
    rmSync(homeTarget, { force: true });
    const homeWrite = run(policy, "/usr/bin/touch", [homeTarget]);
    const planted = existsSync(homeTarget);
    ok("a write to the real $HOME is DENIED", homeWrite.status !== 0 && !planted,
      planted ? `IT WAS NOT — ${homeTarget} now exists, the sandbox did not hold` : homeWrite.stderr.slice(0, 160));
    rmSync(homeTarget, { force: true });

    const ssh = join(home, ".ssh");
    if (existsSync(ssh)) {
      const read = run(policy, "/bin/ls", [ssh]);
      ok("a read of the real ~/.ssh is DENIED", read.status !== 0 && read.stdout === "",
        read.status !== 0 ? read.stderr.slice(0, 160) : `IT WAS NOT — ls printed ${read.stdout.split("\n").length} entries`);
    } else {
      console.log("  note  ~/.ssh does not exist on this machine; the read denial was not exercised");
    }

    // The executable-configuration freeze, against a file this user really has. Denied for WRITE
    // and allowed for READ, which is the whole point of the third list.
    const zshrc = join(home, ".zshrc");
    if (existsSync(zshrc)) {
      const before = spawnSync("/bin/cat", [zshrc], { encoding: "utf8" }).stdout ?? "";
      const write = run(policy, "/bin/sh", ["-c", `echo "# realm sandbox live check" >> ${JSON.stringify(zshrc)}`]);
      const after = spawnSync("/bin/cat", [zshrc], { encoding: "utf8" }).stdout ?? "";
      ok("a write to the real ~/.zshrc is DENIED", write.status !== 0 && after === before,
        after === before ? write.stderr.slice(0, 160) : "IT WAS NOT — ~/.zshrc changed, go and check it");
      const read = run(policy, "/bin/cat", [zshrc]);
      ok("…while reading it still works", read.status === 0 && read.stdout.length > 0, `${read.stdout.length} bytes read`);
    } else {
      console.log("  note  ~/.zshrc does not exist; the read-only freeze was not exercised");
    }

    // A read that must still WORK, so the check above cannot pass by denying everything.
    const readAllowed = run(policy, "/bin/cat", [join(checkout, "file.txt")]);
    ok("an ordinary read still works", readAllowed.status === 0 && readAllowed.stdout === "hello", readAllowed.stderr.slice(0, 160));

    // ── 5. which caches this machine is missing ──────────────────────────────────────────────
    const missing = TOOLCHAIN_CACHE_DIRS.filter((rel) => !existsSync(join(home, rel)));
    console.log(`\n  note  ${missing.length} of ${TOOLCHAIN_CACHE_DIRS.length} toolchain caches do not exist yet on this Mac`);
    if (missing.length > 0) console.log(`        ${missing.join(", ")}`);
    // Each one is still a writable root, resolved to the path it WILL have — an install that has to
    // create its own cache must not fail at mkdir.
    const resolvedMissing = missing.filter((rel) => policy.writableRoots.includes(realRoot(join(home, rel)) ?? ""));
    ok("a cache that does not exist yet is still writable", resolvedMissing.length === missing.length,
      `${resolvedMissing.length}/${missing.length} present in the policy`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  finish();
}

main();
