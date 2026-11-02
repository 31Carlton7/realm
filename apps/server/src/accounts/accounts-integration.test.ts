import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type StartOptions } from "@realm/adapters";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";
import { AccountsStore } from "../store/accounts";
import { accountsRoot } from "./service";

/**
 * A session on an account, through the real RPC surface: the engine starts under the account's
 * folder, and moving a session to another account resumes the provider's conversation there when its
 * record can be carried, and hands over as text when it cannot.
 */
let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} (#${id}) timed out`)); }, 10_000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

class RecordingFake extends FakeAdapter {
  starts: StartOptions[] = [];
  override start(o: StartOptions) { this.starts.push(o); return super.start(o); }
}

async function setup(o: { defaultClaude?: string } = {}) {
  const home = tempDir("realm-accounts-rpc-");
  const claude = new RecordingFake({ script: [
    { on: "go", emit: [{ kind: "text", text: "done" }] },
    { on: "wait", emit: [{ kind: "tool", name: "Bash", input: { command: "ls" }, needsPermission: true, result: "x" }] },
  ] });
  app = await createApp({ home, port: 0, adapters: { claude, fake: new FakeAdapter({ script: [] }) },
    ...(o.defaultClaude ? { accounts: { defaults: { claude: o.defaultClaude } } } : {}) });
  const dir = join(accountsRoot(home), "claude", "work");
  mkdirSync(dir, { recursive: true });
  const work = new AccountsStore(app.db).create({ id: "work", kind: "claude", label: "Work", configDir: dir });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
  const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "claude" })).result;
  return { home, c, sp, session, claude, work };
}

const idle = (c: Awaited<ReturnType<typeof client>>, id: string) =>
  waitFor(async () => (await c.call("sessions.get", { id })).result.status === "idle");

describe("accounts over rpc", () => {
  it("lists each CLI's own account beside the added ones", async () => {
    const { c } = await setup();
    const { accounts } = (await c.call("accounts.list", {})).result;
    expect(accounts.map((a: Any) => a.id)).toEqual(["default-claude", "work", "default-codex"]);
    c.close();
  });

  it("starts a session's engine under its account's folder, and hands over when the conversation cannot be carried", async () => {
    const { c, session, claude, work } = await setup();
    await c.call("sessions.send", { id: session.id, text: "go" });
    await idle(c, session.id);
    expect(claude.starts[0]!.env?.CLAUDE_CONFIG_DIR).toBeUndefined();

    const moved = (await c.call("sessions.setAccount", { id: session.id, accountId: "work" })).result;
    expect(moved).toMatchObject({ accountId: "work", providerSessionId: null });
    const events = (await c.call("sessions.events", { id: session.id, afterSeq: 0, limit: 200 })).result;
    expect(events.find((e: Any) => e.event.type === "handoff").event.payload).toMatchObject({ reason: "switch", note: "Switched from Default to Work" });

    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(() => claude.starts.length === 2);
    expect(claude.starts[1]!.env?.CLAUDE_CONFIG_DIR).toBe(work.configDir);
    expect(claude.starts[1]!.systemContext).toContain("# Switched mid-session");
    c.close();
  });

  it("resumes the provider's conversation on the new account when its record is carried", async () => {
    const own = tempDir("realm-dot-claude-");
    const { c, session, claude, work } = await setup({ defaultClaude: own });
    await c.call("sessions.send", { id: session.id, text: "go" });
    await idle(c, session.id);
    const thread = (await c.call("sessions.get", { id: session.id })).result.providerSessionId as string;
    mkdirSync(join(own, "projects", "-w"), { recursive: true });
    writeFileSync(join(own, "projects", "-w", `${thread}.jsonl`), "{}\n");

    const moved = (await c.call("sessions.setAccount", { id: session.id, accountId: "work" })).result;
    expect(moved).toMatchObject({ accountId: "work", providerSessionId: thread });
    const events = (await c.call("sessions.events", { id: session.id, afterSeq: 0, limit: 200 })).result;
    expect(events.some((e: Any) => e.event.type === "handoff")).toBe(false);

    await c.call("sessions.send", { id: session.id, text: "go" });
    await waitFor(() => claude.starts.length === 2);
    expect(claude.starts[1]!.resume).toBe(thread);
    expect(claude.starts[1]!.env?.CLAUDE_CONFIG_DIR).toBe(work.configDir);
    c.close();
  });

  it("refuses mid-turn, and an account that is not this agent's", async () => {
    const { c, session, sp } = await setup();
    await c.call("sessions.send", { id: session.id, text: "wait" });
    await waitFor(async () => (await c.call("sessions.get", { id: session.id })).result.status === "waiting_permission");
    expect((await c.call("sessions.setAccount", { id: session.id, accountId: "work" })).error.code).toBe("SESSION_BUSY");
    const fake = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result.session;
    expect((await c.call("sessions.setAccount", { id: fake.id, accountId: "work" })).error.code).toBe("BAD_REQUEST");
    c.close();
  });
});
