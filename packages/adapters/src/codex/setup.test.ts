import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexConnection } from "./connection";
import { JsonRpcCallError } from "../jsonrpc/stdio";
import { inspectCodexSetup, readCodexSetup } from "./setup";

const cwd = "/workspace/Realm";
const responses = () => ({
  "config/read": { config: { model: "example-model", model_provider: "local-proxy", model_reasoning_effort: "medium", approval_policy: "never", sandbox_mode: "read-only", api_key: "SECRET", mcp_servers: { service: { command: "SECRET COMMAND", env: { TOKEN: "SECRET" }, enabled: false } } }, origins: { SECRET: "SECRET" } },
  "skills/list": { data: [{ cwd, skills: [{ name: "example", path: "/skills/example/SKILL.md", enabled: false, content: "SECRET" }], errors: [] }] },
  "hooks/list": { data: [{ cwd, hooks: [{ eventName: "sessionStart", sourcePath: "/codex/hooks.json", enabled: true, trustStatus: "trusted", command: "SECRET" }], warnings: [], errors: [] }] },
});
afterEach(() => vi.restoreAllMocks());
describe("read-only Codex setup inspection", () => {
  it("returns only selected metadata and preserves disabled states", async () => {
    const data = responses();
    const request = vi.fn(async (method: string) => data[method as keyof typeof data]);
    const result = await readCodexSetup(request, cwd);
    expect(result.state).toBe("available");
    expect(result.skills[0]?.enabled).toBe(false);
    expect(result.connections[0]).toMatchObject({ enabled: false, authentication: "not_checked" });
    expect(result.settings.provider).toBe("local-proxy");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(request.mock.calls.map(c => c[0])).toEqual(["config/read", "skills/list", "hooks/list"]);
  });
  it("keeps unsupported hooks distinct from available configuration", async () => {
    const data = responses();
    const result = await readCodexSetup(async method => {
      if (method === "hooks/list") throw new JsonRpcCallError(-32601, "SECRET", null);
      return data[method as keyof typeof data];
    }, cwd);
    expect(result.state).toBe("partial");
    expect(result.components.hooks).toBe("unsupported");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("does not report malformed or wrong-cwd responses as empty success", async () => {
    const result = await readCodexSetup(async method => method === "config/read" ? { config: [] } : { data: [{ cwd: "/different", skills: [], hooks: [] }] }, cwd);
    expect(result.state).toBe("unavailable");
  });
  it("marks partial lists and warnings without exposing raw error details", async () => {
    const data = responses();
    const result = await readCodexSetup(async method => method === "skills/list" ? { data: [{ cwd, skills: [null, { name: "valid", path: "/valid" }], errors: [{ message: "SECRET" }] }] } : data[method as keyof typeof data], cwd);
    expect(result.components.skills).toBe("partial");
    expect(result.skills).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("closes the inspection connection without starting a thread", async () => {
    const data = responses();
    const request = vi.fn(async (method: string) => data[method as keyof typeof data]);
    const dispose = vi.fn(async () => {});
    vi.spyOn(CodexConnection, "open").mockResolvedValue({ request, dispose } as unknown as CodexConnection);
    await inspectCodexSetup({ cwd, codexHome: "/selected/codex" });
    expect(CodexConnection.open).toHaveBeenCalledWith(expect.objectContaining({ env: { CODEX_HOME: "/selected/codex" } }));
    expect(request).toHaveBeenCalledTimes(3);
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("reports missing executables without leaking process error output", async () => {
    vi.spyOn(CodexConnection, "open").mockRejectedValue(new Error("SECRET"));
    const result = await inspectCodexSetup({ cwd, codexHome: "/selected/codex" });
    expect(result.state).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
