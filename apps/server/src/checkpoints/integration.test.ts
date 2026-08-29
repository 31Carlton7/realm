import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeAdapter } from "@realm/adapters";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/**
 * Checkpoints through the real RPC surface, against a real repository and a real database — the wiring
 * the unit tests cannot see: that `sessions.send` takes a checkpoint before the adapter is handed the
 * message, that a restore refuses while that adapter is still live, and that removing a worktree takes
 * its checkpoint refs out of the MAIN repository's ref store rather than leaving them pinned there.
 */
let app: App;
afterEach(async () => { await app?.close(); });

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}
function initRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "."); git(dir, "commit", "-qm", "init");
}

/** The fake agent answers "go" with one line of text and nothing else — it never touches the disk, so
 *  the test writes the files an agent would, and the checkpoint is the thing under test. */
const script = [{ on: "go", emit: [{ kind: "text" as const, text: "ok" }] }];

async function boot() {
  const home = mkdtempSync(join(tmpdir(), "realm-cpint-"));
  if (!resolve(home).startsWith(resolve(tmpdir()))) throw new Error(`refusing to run against ${home}`);
  app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script, delayMs: 5 }) } });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result;
  initRepo(sp.folderPath);
  return { home, c, sp };
}
const envOf = async (c: Any, spaceId: string) => (await c.call("environments.list", { spaceId })).result[0];

describe("checkpoints over rpc", () => {
  it("takes a checkpoint of the state BEFORE the turn, labelled from the message", async () => {
    const { c, sp } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    writeFileSync(join(sp.folderPath, "before.txt"), "existing\n");

    await c.call("sessions.send", { id: session.id, text: "go\nsecond line" });
    const env = await envOf(c, sp.id);
    const list = (await c.call("checkpoints.list", { environmentId: env.id, sessionId: session.id })).result;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "turn", label: "go", sessionId: session.id, environmentId: env.id });
    // Ordering, not just presence: the capture happens BEFORE the message reaches the adapter, so its
    // broadcast lands ahead of the `user_message` event. A capture moved after the send would record a
    // tree the agent had already started editing.
    const captured = c.events.findIndex((e: Any) => e.event === "checkpoints.changed" && e.payload.environmentId === env.id);
    const sent = c.events.findIndex((e: Any) => e.event === "session.event" && e.payload.event.type === "user_message");
    expect(captured).toBeGreaterThanOrEqual(0);
    expect(captured).toBeLessThan(sent);

    // Captured before the adapter ran, and it holds the file that existed at that moment.
    expect(git(sp.folderPath, "ls-tree", "-r", "--name-only", `${list[0].commitSha}`)).toContain("before.txt");
    c.close();
  });

  it("refuses to restore while the session's agent is still live, and allows it once it is gone", async () => {
    const { c, sp } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: session.id, text: "go" });
    const env = await envOf(c, sp.id);
    const cp = (await c.call("checkpoints.list", { environmentId: env.id, sessionId: null })).result[0];

    writeFileSync(join(sp.folderPath, "agent.txt"), "written by the agent\n");
    const preview = (await c.call("checkpoints.preview", { id: cp.id })).result;
    expect(preview).toMatchObject({ filesChanged: 1, commitsRolledBack: 0, headMovable: true, intact: true, rewindsConversation: false });

    const blocked = await c.call("checkpoints.restore", { id: cp.id, acknowledge: { filesChanged: 1, commitsRolledBack: 0 } });
    expect(blocked.ok).toBe(false);
    expect(blocked.error.code).toBe("CHECKPOINT_ENVIRONMENT_BUSY");
    expect(existsSync(join(sp.folderPath, "agent.txt"))).toBe(true);

    // Deleting the session disposes the live handle; the environment is then idle.
    await c.call("sessions.delete", { id: session.id });
    await waitFor(async () => (await c.call("sessions.list", { spaceId: sp.id })).result.length === 0);

    const done = await c.call("checkpoints.restore", { id: cp.id, acknowledge: { filesChanged: 1, commitsRolledBack: 0 } });
    expect(done.ok).toBe(true);
    expect(done.result).toMatchObject({ environmentId: env.id, path: sp.folderPath, filesChanged: 1, filesRemoved: 1, conversationRewound: false });
    expect(done.result.undoCheckpointId).not.toBeNull();
    expect(existsSync(join(sp.folderPath, "agent.txt"))).toBe(false);

    // The restore is itself undoable, from the checkpoint it just made.
    const undoPreview = (await c.call("checkpoints.preview", { id: done.result.undoCheckpointId })).result;
    const undone = await c.call("checkpoints.restore", { id: done.result.undoCheckpointId, acknowledge: { filesChanged: undoPreview.filesChanged, commitsRolledBack: undoPreview.commitsRolledBack } });
    expect(undone.ok).toBe(true);
    expect(readFileSync(join(sp.folderPath, "agent.txt"), "utf8")).toBe("written by the agent\n");
    c.close();
  });

  it("still delivers the message when the checkout is not a git repository", async () => {
    const home = mkdtempSync(join(tmpdir(), "realm-cpint-"));
    app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script, delayMs: 5 }) } });
    const c = await client(app.port);
    const p = (await c.call("profiles.create", { name: "W" })).result;
    const sp = (await c.call("spaces.create", { profileId: p.id, name: "S" })).result; // a plain folder
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;

    expect((await c.call("sessions.send", { id: session.id, text: "go" })).ok).toBe(true);
    await waitFor(async () => (await c.call("sessions.events", { id: session.id })).result.some((e: Any) => e.event.type === "assistant_text"));
    const env = await envOf(c, sp.id);
    expect((await c.call("checkpoints.list", { environmentId: env.id, sessionId: null })).result).toEqual([]);
    c.close();
  });

  it("takes a worktree's checkpoint refs out of the main repository when the worktree is removed", async () => {
    const { c, sp } = await boot();
    const worktree = (await c.call("environments.createWorktree", { spaceId: sp.id, title: "side quest" })).result;
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake", environmentId: worktree.id })).result;
    await c.call("sessions.send", { id: session.id, text: "go" });

    const taken = (await c.call("checkpoints.list", { environmentId: worktree.id, sessionId: null })).result;
    expect(taken).toHaveLength(1);
    // Refs under refs/ are shared across a repository's worktrees, so the ref lives in the MAIN checkout.
    expect(git(sp.folderPath, "for-each-ref", "--format=%(refname)", "refs/realm/")).toContain(taken[0].ref);

    await c.call("sessions.delete", { id: session.id });
    // The repository has no remote, so every commit on the branch counts as unpushed — W2's
    // acknowledgement must carry the numbers git actually reports, not the ones we hoped for.
    const st = (await c.call("environments.worktreeStatus", { id: worktree.id })).result;
    const removed = await c.call("environments.removeWorktree", { id: worktree.id, acknowledge: { dirtyFiles: st.dirtyFiles, unpushedCommits: st.unpushedCommits } });
    expect(removed.error ?? null).toBeNull();

    // The directory and the row are gone; so is every object they were pinning in the user's repository.
    expect(git(sp.folderPath, "for-each-ref", "--format=%(refname)", "refs/realm/").trim()).toBe("");
    expect((await c.call("environments.list", { spaceId: sp.id })).result.map((e: Any) => e.id)).not.toContain(worktree.id);
    c.close();
  });
});
