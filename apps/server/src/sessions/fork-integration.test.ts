import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import type { StartOptions } from "@realm/adapters";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/**
 * Plan 16 through the real RPC surface, real database, real repository, real (scripted) adapter:
 *
 *  - a session's text is searchable the moment its events persist, profile-scoped (`search.query`);
 *  - `sessions.fork` makes a NEW worktree at the checkpoint's tree and a NEW session whose adapter
 *    start actually RECEIVES the carried ancestor context — the app.ts fan-out wiring the unit tests
 *    cannot see;
 *  - the ancestor's transcript is byte-identical across the fork.
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

/** A FakeAdapter that remembers every StartOptions it was handed — the seam that proves the fork
 *  context actually reaches an adapter start, rather than merely existing in a settings row. */
class RecordingFake extends FakeAdapter {
  starts: StartOptions[] = [];
  override start(o: StartOptions) { this.starts.push(o); return super.start(o); }
}

describe("fork + search over rpc (Plan 16)", () => {
  it("indexes live session text profile-scoped; forks into a new worktree whose session starts with the carried context", async () => {
    const home = tempDir("realm-forkint-");
    if (!resolve(home).startsWith(resolve(tmpdir()))) throw new Error(`refusing to run against ${home}`);
    const fake = new RecordingFake({ script: [{ on: "go", emit: [{ kind: "text", text: "the walrus is assembled" }] }], delayMs: 5 });
    app = await createApp({ home, port: 0, adapters: { fake } });
    const c = await client(app.port);
    const p = (await c.call("profiles.create", { name: "Work" })).result;
    const other = (await c.call("profiles.create", { name: "School" })).result;
    const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
    git(sp.folderPath, "init", "-q", "-b", "main");
    writeFileSync(join(sp.folderPath, "a.txt"), "one\n");
    git(sp.folderPath, "add", "."); git(sp.folderPath, "commit", "-qm", "init");

    // A real turn: send → per-turn checkpoint → scripted answer → idle.
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "go build the walrus" });
    await waitFor(async () => (await c.call("sessions.get", { id: session.id })).result.status === "idle");

    // W1 live leg: both sides of the turn are searchable NOW, and only inside their own profile.
    const hits = (await c.call("search.query", { profileId: p.id, query: "walrus" })).result;
    expect(hits.sessions).toHaveLength(1);
    expect(hits.sessions[0].sessionId).toBe(session.id);
    const foreign = (await c.call("search.query", { profileId: other.id, query: "walrus" })).result;
    expect(foreign.sessions).toHaveLength(0);

    // The turn's checkpoint — captured before the message — is what we fork from.
    const env = (await c.call("environments.list", { spaceId: sp.id })).result[0];
    const cps = (await c.call("checkpoints.list", { environmentId: env.id, sessionId: session.id })).result;
    expect(cps.length).toBeGreaterThan(0);
    const eventsBefore = JSON.stringify((await c.call("sessions.events", { id: session.id, afterSeq: 0 })).result);

    const fork = (await c.call("sessions.fork", { checkpointId: cps[0].id })).result;
    expect(fork.session.dispatchedBy).toEqual({ kind: "fork", sessionId: session.id });
    expect(fork.environment.kind).toBe("worktree");
    expect(fork.environment.path).not.toBe(env.path);
    expect(readFileSync(join(fork.environment.path, "a.txt"), "utf8")).toBe("one\n");

    // The wiring that only an app-level test can see: the forked session's adapter START carries the
    // fenced summary-of-ancestor through the extraSystemContext fan-out.
    const startsBefore = fake.starts.length;
    await c.call("sessions.send", { id: fork.session.id, text: "continue" });
    await waitFor(async () => (await c.call("sessions.get", { id: fork.session.id })).result.status === "idle");
    const forkStart = fake.starts[startsBefore]!;
    expect(forkStart.cwd).toBe(fork.environment.path);
    expect(forkStart.systemContext).toContain("# Forked session");
    expect(forkStart.systemContext).toContain("go build the walrus");
    expect(forkStart.systemContext).toContain("could not be rewound");
    // …and the ancestor's own start never carried one.
    expect(fake.starts[0]!.systemContext ?? "").not.toContain("# Forked session");

    // The ancestor's transcript is byte-identical across all of it.
    expect(JSON.stringify((await c.call("sessions.events", { id: session.id, afterSeq: 0 })).result)).toBe(eventsBefore);
    c.close();
  });
});
