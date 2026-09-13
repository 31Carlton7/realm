import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { FakeAdapter, type AgentAdapter, type StartOptions } from "@realm/adapters";
import { tempDir } from "@realm/test-utils";
import { createApp, type App } from "../app";

let app: App;
afterEach(async () => { await app?.close(); });

const callClient = async (port: number) => {
  const ws = await new Promise<WebSocket>((resolve, reject) => { const socket = new WebSocket(`ws://127.0.0.1:${port}`); socket.once("open", () => resolve(socket)); socket.once("error", reject); });
  let id = 0;
  return { call: (method: string, params: unknown) => new Promise<any>((resolve) => { const next = String(++id); ws.on("message", function reply(bytes) { const row = JSON.parse(bytes.toString()); if (row.id === next) { ws.off("message", reply); resolve(row); } }); ws.send(JSON.stringify({ id: next, method, params })); }), close: () => ws.close() };
};

describe("Codex setup launch inheritance", () => {
  it("uses profile overrides while leaving unset policy to Codex", async () => {
    const starts: StartOptions[] = [];
    const fake = new FakeAdapter({ script: [] });
    const codex: AgentAdapter = { kind: "codex", probe: async () => ({ kind: "codex", available: true, version: "test", loggedIn: true, reason: null }), start: (opts) => { starts.push(opts); return fake.start(opts); } };
    app = await createApp({ home: tempDir("realm-"), port: 0, adapters: { codex } });
    const client = await callClient(app.port);
    const profile = (await client.call("profiles.create", { name: "Codex" })).result;
    const space = (await client.call("spaces.create", { profileId: profile.id, name: "Work" })).result;
    await client.call("settings.set", { key: `codexSetup.binding:${profile.id}`, value: { profileId: profile.id, receiptId: "receipt", codexHome: "/tmp/codex", extraSkillRoots: [], overrides: { model: "profile-model" }, fingerprint: "fingerprint", appliedAt: 1 } });
    const session = (await client.call("sessions.create", { spaceId: space.id, agentKind: "codex" })).result.session;
    await client.call("sessions.send", { id: session.id, text: "go" });
    expect(starts[0]).toMatchObject({ model: "profile-model" });
    expect(starts[0]!.permissionMode).toBeUndefined();
    expect(starts[0]!.approvalPolicy).toBeUndefined();
    expect(starts[0]!.sandbox).toBeUndefined();
    expect((await client.call("settings.get", { key: `codexSetup.launch:${session.id}` })).result.value).toMatchObject({ profileId: profile.id, model: "profile-model", permissionMode: null });
    client.close();
  });
});
