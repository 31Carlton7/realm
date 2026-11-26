import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type AgentHandle, type StartOptions } from "@realm/adapters";
import { createApp, type App } from "../app";
import { agentShellEnv, installAgentShims } from "./agent-shell";

describe("agentShellEnv", () => {
  it("marks the shell as an agent's and puts the shims first on its PATH", () => {
    expect(agentShellEnv("/home/agent-shell/bin", "/usr/bin:/bin")).toEqual({ REALM_AGENT_SHELL: "1", PATH: "/home/agent-shell/bin:/usr/bin:/bin" });
    expect(agentShellEnv("/home/agent-shell/bin", undefined)).toEqual({ REALM_AGENT_SHELL: "1", PATH: "/home/agent-shell/bin" });
  });
});

// The wrappers are sh scripts.
describe.skipIf(process.platform === "win32")("the electron and electron-vite shims", () => {
  /** A fake of each program after the shims on PATH, which prints what it was started with. */
  function rig() {
    const home = tempDir("realm-agent-shims-");
    const shims = installAgentShims(home);
    const real = join(home, "real-bin");
    mkdirSync(real);
    for (const name of ["electron", "electron-vite"]) {
      writeFileSync(join(real, name), `#!/bin/sh\necho "${name} quiet=$REALM_QUIET_WINDOWS args=$*"\n`);
      chmodSync(join(real, name), 0o755);
    }
    const run = (name: string, args: string[]) =>
      execFileSync(name, args, { env: { PATH: `${shims}:${real}:/usr/bin:/bin`, TMPDIR: "/scratch" }, cwd: home, encoding: "utf8" }).trim();
    return { run };
  }

  it("starts the next electron on PATH quiet, on a user-data folder of its own", () => {
    const out = rig().run("electron", ["."]);
    expect(out).toMatch(/^electron quiet=1 args=--user-data-dir=\/scratch\/realm-agent-shell\/[0-9a-f]{12} \.$/);
  });

  it("keeps a user-data folder the caller chose", () => {
    expect(rig().run("electron", ["--user-data-dir=/mine", "."])).toBe("electron quiet=1 args=--user-data-dir=/mine .");
  });

  it("starts the next electron-vite on PATH quiet, with its arguments as given", () => {
    expect(rig().run("electron-vite", ["dev"])).toBe("electron-vite quiet=1 args=dev");
  });
});

class CapturingAdapter extends FakeAdapter {
  readonly started: StartOptions[] = [];
  override start(opts: StartOptions): AgentHandle {
    this.started.push(opts);
    return super.start(opts);
  }
}

describe("starting an agent", () => {
  let app: App | null = null;
  afterEach(async () => { await app?.close().catch(() => {}); app = null; });

  it("hands its shell REALM_AGENT_SHELL=1 and the shims first on PATH", async () => {
    const home = tempDir("realm-agent-shell-wiring-");
    const fake = new CapturingAdapter();
    app = await createApp({ home, port: 0, adapters: { fake } as never });
    const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${app!.port}`); w.once("open", () => res(w)); w.once("error", rej); });
    let n = 0;
    const call = <T>(method: string, params: unknown) => new Promise<T>((res) => {
      const id = String(++n);
      const onMessage = (d: WebSocket.RawData) => { const m = JSON.parse(d.toString()); if (m.id === id) { ws.off("message", onMessage); res(m.result); } };
      ws.on("message", onMessage);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const profile = await call<{ id: string }>("profiles.create", { name: "W" });
    const space = await call<{ id: string }>("spaces.create", { profileId: profile.id, name: "S" });
    const { session } = await call<{ session: { id: string } }>("sessions.create", { spaceId: space.id, agentKind: "fake" });
    await call("sessions.send", { id: session.id, text: "hi" });
    ws.close();
    const env = fake.started.at(-1)!.env!;
    expect(env.REALM_AGENT_SHELL).toBe("1");
    expect(env.PATH!.split(":")[0]).toBe(join(home, "agent-shell", "bin"));
  });
});
