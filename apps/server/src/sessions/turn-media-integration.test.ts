import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/**
 * The turn-media sweep through the real RPC surface and a real database: a picture a shell command made
 * in a folder that is not the session's own reaches the session's files in the Library, by way of a
 * `files_made` event the server writes at the settle.
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

/** The deck folder lives outside every space, as the Versed deck did for the Realm-space session that made it. */
const scratch = tempDir("realm-tmint-");
const decks = join(scratch, "other-space/decks");
const shared = join(scratch, "shared/decks");

/** "make" names the deck folder from a shell command and parks on its permission, which is the one way
 *  a fake turn can be held open while the test writes the picture the command would have; "talk" runs
 *  no tool at all; "write" indexes a picture through a Write call of its own. */
const script = [
  { on: "make", emit: [{ kind: "tool" as const, name: "Bash", input: { command: `cd ${decks} && node compose.mjs deck v1` }, needsPermission: true, result: "made" }] },
  { on: "talk", emit: [{ kind: "text" as const, text: "ok" }] },
  { on: "share", emit: [{ kind: "tool" as const, name: "Bash", input: { command: `ls ${shared}` }, needsPermission: true, result: "made" }] },
  { on: "write", emit: [{ kind: "tool" as const, name: "Write", input: { file_path: join(shared, "sub/claimed.png"), content: "x" }, needsPermission: true, result: "ok" }] },
];

async function boot() {
  const home = tempDir("realm-tmint-home-");
  if (!resolve(home).startsWith(resolve(tmpdir()))) throw new Error(`refusing to run against ${home}`);
  app = await createApp({ home, port: 0, userHome: tempDir("realm-tmint-user-"), adapters: { fake: new FakeAdapter({ script, delayMs: 5 }) } });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const sp = (await c.call("spaces.create", { profileId: p.id, name: "Realm" })).result;
  return { c, sp };
}

const eventsOf = async (c: Any, id: string): Promise<Any[]> => (await c.call("sessions.events", { id })).result;
const idle = (c: Any, id: string) => waitFor(async () => (await c.call("sessions.get", { id })).result.status === "idle");
/** Hold the turn on its permission, run `during` while it is open, then let it settle. */
async function heldTurn(c: Any, id: string, text: string, during: () => void): Promise<void> {
  await c.call("sessions.send", { id, text });
  let request: Any;
  await waitFor(async () => (request = (await eventsOf(c, id)).find((e) => e.event.type === "permission_request")) != null);
  during();
  await c.call("sessions.respondPermission", { id, requestId: request.event.payload.requestId, decision: "allow" });
  await idle(c, id);
}
const filesOf = async (c: Any, sessionId: string) =>
  (await c.call("library.artifacts", { sessionId, perFile: true })).result.entries.map((e: Any) => e.name).sort();

describe("the media a turn left on disk", () => {
  it("lists a picture a shell command made in a folder outside the session's own, once the turn settles", async () => {
    const { c, sp } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await heldTurn(c, session.id, "make", () => {
      mkdirSync(join(decks, "deck/v1"), { recursive: true });
      writeFileSync(join(decks, "deck/v1/01.png"), "png");
    });
    // THE mutants: no recordTurnMedia at the settle; and the old `toolTurns.delete(id) && fronting`
    // shape, which never measures this space — its folder is not a git repository.
    await waitFor(async () => (await eventsOf(c, session.id)).some((e) => e.event.type === "files_made"));
    const made = (await eventsOf(c, session.id)).filter((e) => e.event.type === "files_made");
    expect(made).toHaveLength(1);
    expect(made[0].event.payload).toMatchObject({ files: [{ path: join(decks, "deck/v1/01.png"), size: 3 }], totalFiles: 1 });
    expect(await filesOf(c, session.id)).toEqual(["01.png"]);
    c.close();
  });

  it("does not look after a turn that ran no tool", async () => {
    const { c, sp } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    writeFileSync(join(sp.folderPath, "fresh.png"), "png");
    await c.call("sessions.send", { id: session.id, text: "talk" });
    await idle(c, session.id);
    await new Promise((r) => setTimeout(r, 100));
    // THE mutant: sweeping on every settle, which would claim this picture for a turn of prose.
    expect((await eventsOf(c, session.id)).filter((e) => e.event.type === "files_made")).toEqual([]);
    c.close();
  });

  it("leaves a picture to the session that already indexed it, and to the turn's own Write", async () => {
    const { c, sp } = await boot();
    const { session: writer } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    const { session: looker } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
    await c.call("sessions.send", { id: looker.id, text: "share" });
    let request: Any;
    await waitFor(async () => (request = (await eventsOf(c, looker.id)).find((e) => e.event.type === "permission_request")) != null);
    // While the looker's turn is open, the writer writes a picture through Write, which indexes it.
    // (In a folder of its own under the shared one, so the writer's sweep never reaches mine.png.)
    await heldTurn(c, writer.id, "write", () => {
      mkdirSync(join(shared, "sub"), { recursive: true });
      writeFileSync(join(shared, "sub/claimed.png"), "png");
    });
    writeFileSync(join(shared, "mine.png"), "png");
    await c.call("sessions.respondPermission", { id: looker.id, requestId: request.event.payload.requestId, decision: "allow" });
    await idle(c, looker.id);
    await waitFor(async () => (await eventsOf(c, looker.id)).some((e) => e.event.type === "files_made"));
    const made = (await eventsOf(c, looker.id)).find((e) => e.event.type === "files_made");
    // THE mutant: no cross-session dedupe — the looker would list claimed.png as its own too.
    expect(made.event.payload.files.map((f: Any) => f.path)).toEqual([join(shared, "mine.png")]);
    // The writer's own sweep skips what its Write already indexed, so it writes no files_made at all.
    await new Promise((r) => setTimeout(r, 100));
    expect((await eventsOf(c, writer.id)).filter((e) => e.event.type === "files_made")).toEqual([]);
    expect(await filesOf(c, writer.id)).toEqual(["claimed.png"]);
    c.close();
  });
});
