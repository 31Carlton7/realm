import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { fetchAcpModels, probeAcp } from "./probe";

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

});

describe("fetchAcpModels", () => {
  const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
  const opts = (env: Record<string, string> = {}) => ({ bin: process.execPath, args: [FAKE], cwd: process.cwd(), env }); // StdioJsonRpc merges over process.env

  it("opens a throwaway session and reads the catalog off session/new", async () => {
    expect(await fetchAcpModels(opts())).toEqual([{ id: "fake-model-1", label: "Fake 1" }, { id: "fake-model-2", label: "Fake 2" }]);
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
