import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { AGENT_INSTALL_ROUTES, AgentKindSchema, type AgentKind, type CliJobEnd, type CliJobOutput } from "@realm/contracts";
import { CliInstaller, commandSpec, specFor } from "./install";

/**
 * A child process that never was. Every install test runs against this — a real package manager must
 * never be invoked by the suite, and the machine the suite runs on is not a fixture.
 */
function fakeSpawn() {
  const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const children: (EventEmitter & { stdout: Readable; stderr: Readable; kill: ReturnType<typeof vi.fn> })[] = [];
  const impl = ((file: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ file, args, opts });
    const child = Object.assign(new EventEmitter(), {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      kill: vi.fn(),
    });
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof nodeSpawn;
  return { impl, calls, children, last: () => children[children.length - 1]! };
}

function harness() {
  const output: CliJobOutput[] = [];
  const done: CliJobEnd[] = [];
  const probes: number[] = [];
  const spawner = fakeSpawn();
  const installer = new CliInstaller({
    onOutput: (e) => output.push(e),
    onDone: (e) => done.push(e),
    afterRun: async () => { probes.push(done.length); },
    spawnImpl: spawner.impl,
    env: { PATH: "/stub" },
  });
  return { installer, output, done, probes, spawner };
}

/** Resolves once the installer's post-run probe and done callback have both flushed. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("commandSpec", () => {
  it("spawns npm as argv, never through a shell", () => {
    const spec = commandSpec(AGENT_INSTALL_ROUTES.codex, "install", null);
    expect(spec).toEqual({ display: "npm install -g @openai/codex", file: "npm", args: ["install", "-g", "@openai/codex"] });
  });

  it("pins an npm update to the version that was checked", () => {
    expect(commandSpec(AGENT_INSTALL_ROUTES.codex, "update", "0.153.4")).toEqual({
      display: "npm install -g @openai/codex@0.153.4", file: "npm", args: ["install", "-g", "@openai/codex@0.153.4"],
    });
  });

  it("uses brew install to install and brew upgrade to update", () => {
    expect(commandSpec(AGENT_INSTALL_ROUTES["acp:goose"], "install", null)?.args).toEqual(["install", "block-goose-cli"]);
    expect(commandSpec(AGENT_INSTALL_ROUTES["acp:goose"], "update", "1.9.0")?.args).toEqual(["upgrade", "block-goose-cli"]);
  });

  it("runs a vendor pipeline through a plain non-login, non-interactive shell", () => {
    // -l or -i would re-run the user's rc files and could block on a prompt; the server already
    // carries the merged login PATH, so the shell exists only to interpret the pipe.
    const spec = commandSpec(AGENT_INSTALL_ROUTES["acp:fx"], "install", null);
    expect(spec?.file).toBe("/bin/bash");
    expect(spec?.args[0]).toBe("-c");
    expect(spec?.args).not.toContain("-l");
    expect(spec?.args).not.toContain("-i");
    expect(spec?.args[1]).toBe("curl -fsSL https://fx.sh/setup.sh | bash");
  });

  it("never offers to update a script route", () => {
    expect(commandSpec(AGENT_INSTALL_ROUTES["acp:fx"], "update", "1.0.0")).toBe(null);
    expect(commandSpec(AGENT_INSTALL_ROUTES["acp:cursor"], "update", "1.0.0")).toBe(null);
  });

  it("has nothing to run for the compiled-in fake adapter", () => {
    expect(specFor("fake", "install", null)).toBe(null);
    expect(specFor("fake", "update", "1.0.0")).toBe(null);
  });

  it("runs exactly the command it shows, for every argv-shaped route", () => {
    // The promise this feature makes is that the string a user reads before clicking is the string
    // that runs. For npm and brew that is checkable literally.
    for (const kind of AgentKindSchema.options) {
      for (const action of ["install", "update"] as const) {
        const spec = commandSpec(AGENT_INSTALL_ROUTES[kind], action, "9.9.9");
        if (!spec || spec.file === "/bin/bash") continue;
        expect([spec.file, ...spec.args].join(" ")).toBe(spec.display);
      }
    }
  });

  it("refuses an update with no version to pin to", () => {
    expect(commandSpec(AGENT_INSTALL_ROUTES.codex, "update", null)).toBe(null);
  });
});

describe("CliInstaller", () => {
  const npmSpec = commandSpec(AGENT_INSTALL_ROUTES.codex, "install", null)!;

  it("spawns the spec's argv with no shell and with stdin closed", () => {
    const h = harness();
    h.installer.start("codex", "install", npmSpec);
    const call = h.spawner.calls[0]!;
    expect(call.file).toBe("npm");
    expect(call.args).toEqual(["install", "-g", "@openai/codex"]);
    expect(call.opts.shell).toBe(false);
    // A package manager that decides to prompt must fail fast, not block on a TTY it has not got.
    expect(call.opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("turns colour off so the streamed output is readable text", () => {
    const h = harness();
    h.installer.start("codex", "install", npmSpec);
    expect(h.spawner.calls[0]!.opts.env).toMatchObject({ NO_COLOR: "1", FORCE_COLOR: "0", PATH: "/stub" });
  });

  it("echoes back the exact command it started", () => {
    const h = harness();
    expect(h.installer.start("codex", "install", npmSpec)).toMatchObject({
      kind: "codex", action: "install", command: "npm install -g @openai/codex",
    });
  });

  it("streams stdout and stderr in the order they arrived, under one job id", async () => {
    const h = harness();
    const job = h.installer.start("codex", "install", npmSpec);
    const child = h.spawner.last();
    child.stdout.push("added 1 package\n");
    child.stderr.push("npm warn deprecated\n");
    await settle();
    expect(h.output.map((o) => o.chunk)).toEqual(["added 1 package\n", "npm warn deprecated\n"]);
    expect(h.output.every((o) => o.id === job.id && o.kind === "codex")).toBe(true);
  });

  it("re-probes before announcing it is done, so a client that refetches sees the new machine", async () => {
    // Both callbacks write to one list, so the order recorded is the order they actually fired in —
    // reading two separate lists afterwards cannot tell the two orderings apart.
    const order: string[] = [];
    const spawner = fakeSpawn();
    const ends: CliJobEnd[] = [];
    const installer = new CliInstaller({
      onOutput: () => {},
      onDone: (e) => { order.push("done"); ends.push(e); },
      afterRun: async () => { order.push("probe"); },
      spawnImpl: spawner.impl,
    });
    installer.start("codex", "install", npmSpec);
    spawner.last().emit("close", 0);
    await settle();
    expect(order).toEqual(["probe", "done"]);
    expect(ends[0]).toMatchObject({ kind: "codex", ok: true, code: 0, error: null });
  });

  it("re-probes after a failure too — a failed install can still have changed the machine", async () => {
    const h = harness();
    h.installer.start("codex", "install", npmSpec);
    h.spawner.last().emit("close", 1);
    await settle();
    expect(h.probes.length).toBe(1);
    expect(h.done[0]).toMatchObject({ ok: false, code: 1 });
    expect(h.done[0]!.error).toContain("1");
  });

  it("reports a missing package manager as the error it is", async () => {
    const h = harness();
    h.installer.start("codex", "install", npmSpec);
    h.spawner.last().emit("error", new Error("spawn npm ENOENT"));
    await settle();
    expect(h.done[0]).toMatchObject({ ok: false, code: null });
    expect(h.done[0]!.error).toContain("ENOENT");
  });

  it("finishes exactly once when error and close both fire", async () => {
    const h = harness();
    h.installer.start("codex", "install", npmSpec);
    const child = h.spawner.last();
    child.emit("error", new Error("spawn npm ENOENT"));
    child.emit("close", null);
    await settle();
    expect(h.done.length).toBe(1);
    expect(h.done[0]!.error).toContain("ENOENT");
  });

  it("refuses a second run for the same kind, so two writers never race one global prefix", async () => {
    const h = harness();
    h.installer.start("codex", "install", npmSpec);
    expect(h.installer.running("codex")).toBe(true);
    expect(() => h.installer.start("codex", "install", npmSpec)).toThrow(/already installing/);
    expect(h.spawner.calls.length).toBe(1);
    h.spawner.last().emit("close", 0);
    await settle();
    expect(h.installer.running("codex")).toBe(false);
    h.installer.start("codex", "install", npmSpec);
    expect(h.spawner.calls.length).toBe(2);
  });

  it("allows two different kinds at once", () => {
    const h = harness();
    h.installer.start("codex", "install", npmSpec);
    h.installer.start("acp:goose", "install", commandSpec(AGENT_INSTALL_ROUTES["acp:goose"], "install", null)!);
    expect(h.spawner.calls.length).toBe(2);
  });

  it("kills a command that has run too long", async () => {
    const h = harness();
    const installer = new CliInstaller({
      onOutput: () => {}, onDone: () => {}, afterRun: async () => {},
      spawnImpl: h.spawner.impl, timeoutMs: 1,
    });
    installer.start("codex", "install", npmSpec);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.spawner.last().kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stops narrating a runaway log instead of flooding the socket", async () => {
    const h = harness();
    h.installer.start("codex", "install", npmSpec);
    const child = h.spawner.last();
    for (let i = 0; i < 40; i++) child.stdout.push("x".repeat(10_000));
    await settle();
    expect(h.output.length).toBeLessThan(40);
    expect(h.output[h.output.length - 1]!.chunk).toContain("truncated");
  });

  it("kills everything still running on shutdown", () => {
    const h = harness();
    h.installer.start("codex", "install", npmSpec);
    h.installer.disposeAll();
    expect(h.spawner.last().kill).toHaveBeenCalledWith("SIGTERM");
    expect(h.installer.running("codex" as AgentKind)).toBe(false);
  });
});
