import { describe, expect, it } from "vitest";
import type { ExecutionSandboxPolicy } from "@realm/contracts";
import { SANDBOX_EXEC_PATH, sandboxCommand, sandboxEnv } from "./spawn";

const policy = (o: Partial<ExecutionSandboxPolicy> = {}): ExecutionSandboxPolicy => ({
  posture: "workspace-write", writableRoots: ["/w"], readableRoots: [], readOnlyPaths: [], protectedRoots: ["/p"], network: true, ...o,
});

describe("the argv", () => {
  it("runs the system sandbox-exec by absolute path, never by PATH lookup", () => {
    const out = sandboxCommand({ command: "/bin/echo", args: ["hi"], policy: policy() });
    expect(out.command).toBe("/usr/bin/sandbox-exec");
    expect(SANDBOX_EXEC_PATH).toBe("/usr/bin/sandbox-exec");
  });

  it("passes the profile inline and every root as a -D parameter", () => {
    const out = sandboxCommand({ command: "/bin/echo", args: ["hi"], policy: policy() });
    expect(out.args[0]).toBe("-p");
    expect(out.args[1]).toContain("(deny default)");
    expect(out.args).toContain("REALM_WRITE_0=/w");
    expect(out.args).toContain("REALM_PROTECTED_0=/p");
    // Each value is one argv element, so a path with a space or a newline in it needs no quoting at
    // any layer — there is no shell between here and execve.
    for (const a of out.args) expect(typeof a).toBe("string");
  });

  it("separates the command with `--`, so a command whose name starts with a dash still runs", () => {
    const out = sandboxCommand({ command: "-weird-binary", args: ["-x"], policy: policy() });
    const sep = out.args.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    expect(out.args.slice(sep)).toEqual(["--", "-weird-binary", "-x"]);
  });

  it("keeps the command's own arguments verbatim and in order", () => {
    const args = ["--acp", "--flag=value with spaces", "", "-"];
    const out = sandboxCommand({ command: "/usr/bin/agent", args, policy: policy() });
    expect(out.args.slice(out.args.indexOf("--") + 1)).toEqual(["/usr/bin/agent", ...args]);
  });

  it("is deterministic — the same policy produces the same argv", () => {
    const a = sandboxCommand({ command: "/bin/echo", args: [], policy: policy({ writableRoots: ["/b", "/a"] }) });
    const b = sandboxCommand({ command: "/bin/echo", args: [], policy: policy({ writableRoots: ["/a", "/b"] }) });
    expect(a).toEqual(b);
  });
});

describe("the `off` branch is the only way to an unwrapped command", () => {
  it("hands back the original command, flagged, when the posture is off", () => {
    const out = sandboxCommand({ command: "/bin/zsh", args: ["-l"], policy: policy({ posture: "off" }) });
    expect(out.sandboxed).toBe(false);
    expect(out.command).toBe("/bin/zsh");
    expect(out.args).toEqual(["-l"]);
    if (out.sandboxed === false) expect(out.reason).toMatch(/posture for this space is set to off/);
  });

  it("never returns sandboxed:false for a posture that asked for a sandbox", () => {
    // The mutant this is aimed at: a `try { compile } catch { return unwrapped }` added later. Every
    // non-`off` policy here either throws or comes back sandboxed — there is no third outcome.
    for (const posture of ["workspace-write", "read-only"] as const) {
      for (const roots of [[], ["/w"], ["/w", "/x"]]) {
        const out = sandboxCommand({ command: "/bin/echo", args: [], policy: policy({ posture, writableRoots: roots }) });
        expect(out.sandboxed).toBe(true);
        expect(out.command).toBe(SANDBOX_EXEC_PATH);
      }
    }
  });

  it("throws rather than degrading when a root cannot be compiled", () => {
    expect(() => sandboxCommand({ command: "/bin/echo", args: [], policy: policy({ writableRoots: ["/"] }) }))
      .toThrow(/filesystem root/);
    expect(() => sandboxCommand({ command: "/bin/echo", args: [], policy: policy({ writableRoots: ["relative"] }) }))
      .toThrow(/not absolute/);
  });
});

describe("sandboxEnv", () => {
  it("states the posture and the network switch, and nothing a process could use as a control", () => {
    expect(sandboxEnv(policy())).toEqual({ REALM_SANDBOX: "workspace-write", REALM_SANDBOX_NETWORK: "1" });
    expect(sandboxEnv(policy({ posture: "read-only", network: false })))
      .toEqual({ REALM_SANDBOX: "read-only", REALM_SANDBOX_NETWORK: "0" });
    expect(sandboxEnv(policy({ posture: "off" })).REALM_SANDBOX).toBe("off");
  });
});
