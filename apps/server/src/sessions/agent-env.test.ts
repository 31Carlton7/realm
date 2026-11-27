import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type AgentHandle, type StartOptions } from "@realm/adapters";
import { createApp, type App } from "../app";

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

  it("hands its shell REALM_AGENT_SHELL=1", async () => {
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
  });
});
