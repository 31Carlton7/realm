import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import type { AgentHandle, StartOptions } from "@realm/adapters";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/**
 * The execution sandbox as the rest of Realm meets it: over the wire, through a real terminal, and
 * at the moment an agent is started.
 *
 * The unit suites beside this one prove the policy is correct. This one proves it is CONNECTED —
 * and, just as much, that it is connected to nothing at all for a user who has not opted in.
 */

const apps: App[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close().catch(() => {}); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>(); const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} (#${id}) timed out`)); }, 10_000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, events, close: () => ws.close() };
}

/** A scripted adapter that also keeps the options it was started with — the only way to see whether
 *  a `wrap` was handed over, which is the whole question on the agent side. */
class CapturingAdapter extends FakeAdapter {
  readonly started: StartOptions[] = [];
  override start(opts: StartOptions): AgentHandle {
    this.started.push(opts);
    return super.start(opts);
  }
}

async function boot(adapters?: Record<string, unknown>) {
  const home = tempDir("realm-sandbox-wiring-");
  const app = await createApp({ home, port: 0, adapters: (adapters ?? { fake: new FakeAdapter() }) as Any });
  apps.push(app);
  const c = await client(app.port);
  const profile = (await c.call("profiles.create", { name: "W" })).result;
  const space = (await c.call("spaces.create", { profileId: profile.id, name: "S" })).result;
  return { app, home, c, space };
}

const ON = { posture: "workspace-write" as const, network: true };

describe("sandbox over rpc", () => {
  it("reports an untouched space as inherited and OFF — this release ships opt-in", async () => {
    const { c, space } = await boot();
    const st = (await c.call("sandbox.get", { spaceId: space.id })).result;
    // MUTANT: flip EXECUTION_SANDBOX_DEFAULT_POSTURE back to workspace-write without settling the
    // two preconditions written on it, and this is where it is noticed.
    expect(st.prefs).toEqual({ posture: "off", network: true });
    expect(st.inherited).toBe(true);
    expect(st.defaults).toEqual({ posture: "off", network: true });
    expect(st.policy.posture).toBe("off");
    expect(st.summary).toMatch(/^Not sandboxed/);
    c.close();
  });

  it("stores a space's posture, resolves it, and clears it back to the default", async () => {
    const { c, space } = await boot();
    const on = (await c.call("sandbox.set", { spaceId: space.id, prefs: ON })).result;
    expect(on.prefs).toEqual(ON);
    expect(on.inherited).toBe(false);
    // The resolved policy, not just the stored name: this space's own checkout is writable and the
    // credential directories are not readable. Without it the picker would be describing a policy
    // nobody can check.
    expect(on.policy.writableRoots.length).toBeGreaterThan(0);
    expect(on.policy.protectedRoots.some((r: string) => r.endsWith("/.ssh"))).toBe(true);
    expect(on.summary).toMatch(/^Sandboxed:/);

    const cleared = (await c.call("sandbox.set", { spaceId: space.id, prefs: null })).result;
    expect(cleared).toMatchObject({ prefs: { posture: "off" }, inherited: true });
    c.close();
  });

  it("moves every inheriting space at once when the default changes", async () => {
    const { c, space } = await boot();
    expect((await c.call("sandbox.setDefaults", { prefs: { posture: "read-only", network: false } })).result)
      .toEqual({ posture: "read-only", network: false });
    const st = (await c.call("sandbox.get", { spaceId: space.id })).result;
    expect(st.prefs).toEqual({ posture: "read-only", network: false });
    expect(st.inherited).toBe(true);
    c.close();
  });

  it("survives a restart — the posture is a stored row, not process state", async () => {
    const { app, home, c, space } = await boot();
    await c.call("sandbox.set", { spaceId: space.id, prefs: ON });
    c.close();
    await app.close(); apps.splice(apps.indexOf(app), 1);

    const app2 = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter() } }); apps.push(app2);
    const c2 = await client(app2.port);
    expect((await c2.call("sandbox.get", { spaceId: space.id })).result.prefs).toEqual(ON);
    c2.close();
  });
});

describe("a terminal in an un-opted-in space", () => {
  it("says REALM_SANDBOX=off in the shell, from a real pty", async () => {
    const { c, space } = await boot();
    const { terminalId } = (await c.call("terminals.create", { spaceId: space.id })).result;
    // Colons rather than brackets: `[off]` is a glob in zsh, and an unmatched one makes the shell
    // answer "no matches found" instead of echoing anything.
    await c.call("terminals.write", { terminalId, data: "echo SB=:$REALM_SANDBOX: NET=:$REALM_SANDBOX_NETWORK:\n" });
    const printed = () => c.events.filter((e) => e.event === "terminal.data" && e.payload.terminalId === terminalId).map((e) => String(e.payload.data)).join("");
    // The posture a shell is under, visible IN that shell. Nothing reads these back — they exist so
    // "why did this write fail" has a cause the person looking at the failure can see.
    // MUTANT: drop the sandbox env from `envFor` and the shell answers `SB=::`.
    await waitFor(() => printed().includes("SB=:off: NET=:1:"), { timeout: 15_000 });
    c.close();
  });
});

describe("starting an agent", () => {
  it("hands a sandboxed space's session a wrap, and an un-opted-in one nothing at all", async () => {
    const fake = new CapturingAdapter();
    const { c, space } = await boot({ fake });

    const a = (await c.call("sessions.create", { spaceId: space.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: a.session.id, text: "hi" });
    // MUTANT: pass `wrap` unconditionally (an identity function under `off`) and this is the line
    // that notices — along with every Codex session in a default-configuration Realm.
    expect(fake.started.at(-1)!.wrap).toBeUndefined();
    // …and the env still states the posture, so a log line can say which one this process ran under.
    expect(fake.started.at(-1)!.env).toMatchObject({ REALM_SANDBOX: "off" });

    await c.call("sandbox.set", { spaceId: space.id, prefs: ON });
    const b = (await c.call("sessions.create", { spaceId: space.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: b.session.id, text: "hi" });
    const wrap = fake.started.at(-1)!.wrap;
    expect(wrap).toBeTypeOf("function");
    expect(wrap!("/bin/zsh", ["-l"]).command).toBe("/usr/bin/sandbox-exec");
    expect(fake.started.at(-1)!.env).toMatchObject({ REALM_SANDBOX: "workspace-write" });
    c.close();
  });

  it("refuses a Codex session in a sandboxed space rather than running it unconfined", async () => {
    // DECISION 2. `CodexAdapter` refcounts one `codex app-server` across every session, so one
    // process cannot hold two spaces' policies. The refusal is here, before a gateway token is
    // minted, and it names the reason — a user who wants Codex sets the space to `off` and knows it.
    const codex = new CapturingAdapter();
    const { c, space } = await boot({ codex });
    await c.call("sandbox.set", { spaceId: space.id, prefs: ON });
    const s = (await c.call("sessions.create", { spaceId: space.id, agentKind: "codex" })).result;

    const failed = await c.call("sessions.send", { id: s.session.id, text: "hi" });
    expect(failed.error.code).toBe("SANDBOX_AGENT_UNSUPPORTED");
    expect(failed.error.message).toMatch(/one `codex app-server` process/);
    expect(failed.error.message).toMatch(/No sandbox/);
    // MUTANT: let the session through and this adapter would have been started — with a policy it
    // has nowhere to put.
    expect(codex.started).toEqual([]);

    // The way out is the user's own, stored choice, and it works immediately.
    await c.call("sandbox.set", { spaceId: space.id, prefs: { posture: "off", network: true } });
    expect((await c.call("sessions.send", { id: s.session.id, text: "hi" })).error).toBeUndefined();
    expect(codex.started).toHaveLength(1);
    expect(codex.started[0]!.wrap).toBeUndefined();
    c.close();
  });

  it("starts a Codex session normally in a default-configuration Realm", async () => {
    // The other half: the refusal must bite only where a sandbox was actually asked for. Every space
    // ships `off`, so nothing about Codex changes for anyone who has not opted in.
    const codex = new CapturingAdapter();
    const { c, space } = await boot({ codex });
    const s = (await c.call("sessions.create", { spaceId: space.id, agentKind: "codex" })).result;
    expect((await c.call("sessions.send", { id: s.session.id, text: "hi" })).error).toBeUndefined();
    expect(codex.started).toHaveLength(1);
    c.close();
  });
});
