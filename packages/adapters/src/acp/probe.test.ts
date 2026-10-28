import { afterEach, describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";
import { fetchAcpCatalog, fetchAcpModels, probeAcp } from "./probe";

describe("probeAcp", () => {
  it("reports unavailable with a reason when the binary is missing", async () => {
    const r = await probeAcp("/definitely/not/a/binary");
    expect(r).toMatchObject({ available: false, version: null, loggedIn: null });
    expect(r.reason).toBeTruthy();
  });

  it("reports available with a version and an unknown login state", async () => {
    const r = await probeAcp(process.execPath, ["-e", "console.log('2026.07.25-e42b078')"]);
    expect(r).toMatchObject({ available: true, version: "2026.07.25-e42b078", loggedIn: null });
    expect(r.reason).toBe("unknown until a session starts");
  });

  it("takes only the first line of multi-line --version output", async () => {
    const r = await probeAcp(process.execPath, ["-e", "console.log('2026.07.25-e42b078\\nextra diagnostic line')"]);
    expect(r.version).toBe("2026.07.25-e42b078");
  });

  it("coerces empty --version output to a null version", async () => {
    const r = await probeAcp(process.execPath, ["-e", "console.log('')"]);
    expect(r.available).toBe(true);
    expect(r.version).toBeNull();
  });

  it("marks a CLI that dies of a signal as crashed, and one that only exits non-zero or is missing as not", async () => {
    // What a binary macOS refuses to run looks like to the probe: killed by SIGKILL, no answer.
    const killed = await probeAcp(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
    expect(killed).toMatchObject({ available: false, crashed: true });
    const failed = await probeAcp(process.execPath, ["-e", "process.exit(2)"]);
    expect(failed.available).toBe(false);
    expect(failed.crashed).toBeUndefined();
    expect((await probeAcp("/definitely/not/a/binary")).crashed).toBeUndefined();
  });
});

describe("fetchAcpModels", () => {
  const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
  const opts = (env: Record<string, string> = {}) => ({ bin: process.execPath, args: [FAKE], cwd: process.cwd(), env }); // StdioJsonRpc merges over process.env

  it("opens a throwaway session and reads the catalog off session/new", async () => {
    expect(await fetchAcpModels(opts())).toEqual([{ id: "fake-model-1", label: "Fake 1" }, { id: "fake-model-2", label: "Fake 2" }]);
  });

  it("reads the agent's reasoning levels off the same throwaway session, and none from the old shape", async () => {
    expect(await fetchAcpCatalog(opts({ FAKE_ACP_CONFIGOPTIONS: "1" }))).toMatchObject({
      efforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }], defaultEffort: "medium",
    });
    expect(await fetchAcpCatalog(opts())).toMatchObject({ efforts: [], defaultEffort: null });
  });

  it("keeps only the well-formed rows of a polluted catalog", async () => {
    expect(await fetchAcpModels(opts({ FAKE_ACP_MODEL_GARBAGE: "1" }))).toEqual([{ id: "fake-model-1", label: "Fake 1" }, { id: "fake-model-2", label: "fake-model-2" }]);
  });

  it("answers null when session/new fails, and when the binary is missing", async () => {
    expect(await fetchAcpModels(opts({ FAKE_ACP_STARTFAIL: "1" }))).toBeNull();
    expect(await fetchAcpModels({ bin: "/definitely/not/a/binary", args: [], cwd: process.cwd() })).toBeNull();
  });

  it("answers null (within the bound) when the agent handshakes and then goes mute", async () => {
    expect(await fetchAcpModels({ ...opts({ FAKE_ACP_MUTE_SESSION_NEW: "1" }), timeoutMs: 500 })).toBeNull();
  });
});

describe("what a probe leaves running once it has answered", () => {
  const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
  const dirs: string[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  /** Gone within a second: a process killed a moment ago stays signalable until launchd has reaped it. */
  const gone = async (pid: number) => {
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
    return !alive(pid);
  };
  const childOf = (env: Record<string, string>) => {
    const dir = tempDir("realm-acp-probe-"); dirs.push(dir);
    return { opts: { bin: process.execPath, args: [FAKE], cwd: process.cwd(), env: { ...env, FAKE_ACP_CHILD_PID: join(dir, "pid") } }, pid: () => Number(readFileSync(join(dir, "pid"), "utf8")), dir };
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      const file = join(dir, "pid");
      if (existsSync(file)) { const pid = Number(readFileSync(file, "utf8")); if (alive(pid)) process.kill(pid, "SIGKILL"); }
    }
  });

  it.skipIf(process.platform === "win32")("takes what the agent started down with it, when the agent exits on its own", async () => {
    // Hermes starts the MCP servers in its own config at boot. THE MUTANT: ending the agent alone, which
    // leaves each of those under launchd for good — a Realm process nothing will ever stop.
    const c = childOf({});
    expect(await fetchAcpModels(c.opts)).not.toBeNull();
    expect(await gone(c.pid())).toBe(true);
  });

  it.skipIf(process.platform === "win32")("and when the agent has to be killed", async () => {
    const c = childOf({ FAKE_ACP_IGNORE_EOF: "1" });
    expect(await fetchAcpModels(c.opts)).not.toBeNull();
    expect(await gone(c.pid())).toBe(true);
  });
});
