import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import { createApp, type App } from "../app";
import { MEDIA_BACKFILL_KEY } from "./service";

/**
 * The one-shot catch-up (`SessionService.backfillTurnMedia`): the pictures the last fortnight's tool
 * turns left on disk, from before the settle looked for them, written as `files_made` with each turn's
 * own settle time — and without moving a session in the list or giving it a dot.
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
  const call = (method: string, params: unknown) => new Promise<Any>((res) => {
    const id = String(++n); pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

const NOW = Date.now();
const DAY = 86_400_000;
const T = NOW - 3 * DAY;
const OLD = NOW - 20 * DAY;

function put(path: string, at: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "png");
  utimesSync(path, at / 1000, at / 1000);
}

async function seeded() {
  const home = tempDir("realm-tmbf-");
  if (!resolve(home).startsWith(resolve(tmpdir()))) throw new Error(`refusing to run against ${home}`);
  app = await createApp({ home, port: 0, userHome: tempDir("realm-tmbf-user-"), adapters: { fake: new FakeAdapter({ script: [] }) } });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const sp = (await c.call("spaces.create", { profileId: p.id, name: "Realm" })).result;
  const { session } = (await c.call("sessions.create", { spaceId: sp.id, agentKind: "fake" })).result;
  const decks = join(tempDir("realm-tmbf-work-"), "versed/decks");
  const ev = app.db.prepare("INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (?, ?, ?, ?)");
  const turn = (at: number, tool: boolean) => {
    ev.run(session.id, at, "user_message", JSON.stringify({ text: "go", attachments: [] }));
    ev.run(session.id, at, "status", JSON.stringify({ status: "running" }));
    if (tool) ev.run(session.id, at + 1_000, "tool_call", JSON.stringify({ toolUseId: `t${at}`, name: "Bash", input: { command: `cd ${decks} && node compose.mjs` }, parentToolUseId: null }));
    ev.run(session.id, at + 2_000, "assistant_text", JSON.stringify({ messageId: `m${at}`, text: "done" }));
    ev.run(session.id, at + 10_000, "status", JSON.stringify({ status: "idle" }));
  };
  turn(OLD, true);
  turn(T, true);
  turn(T + 20_000, false);
  const last = (app.db.prepare("SELECT MAX(seq) AS s FROM session_events WHERE session_id = ?").get(session.id) as { s: number }).s;
  // Read to the end, and last touched long ago.
  app.db.prepare("UPDATE sessions SET last_event_seq = ?, seen_seq = ?, updated_at = ? WHERE id = ?").run(last, last, NOW - DAY, session.id);
  put(join(decks, "v1/01.png"), T + 5_000); // the tool turn's
  put(join(sp.folderPath, "02.png"), T + 25_000); // during the turn of prose
  put(join(decks, "03.png"), OLD + 5_000); // the turn three weeks ago
  app.db.prepare("DELETE FROM settings WHERE key = ?").run(MEDIA_BACKFILL_KEY);
  return { c, session, decks, last };
}

const madeOf = async (c: Any, id: string) =>
  (await c.call("sessions.events", { id })).result.filter((e: Any) => e.event.type === "files_made");

describe("the media catch-up", () => {
  it("writes what each recent tool turn made, at the turn's own settle, and nothing for a turn of prose or one too old", async () => {
    const { c, session, decks, last } = await seeded();
    expect(await app.sessions.backfillTurnMedia({ now: NOW })).toBe(1);
    const made = await madeOf(c, session.id);
    // THE mutants: sweeping a turn that ran no tool (02.png), ignoring the fortnight (03.png), or
    // stamping the event with today rather than the settle (the Library would file it under today).
    expect(made).toHaveLength(1);
    expect(made[0].event).toMatchObject({ ts: T + 10_000, payload: { settledAt: T + 10_000, files: [{ path: join(decks, "v1/01.png") }] } });
    const lib = (await c.call("library.artifacts", { sessionId: session.id, perFile: true })).result.entries;
    expect(lib.map((e: Any) => [e.name, e.ts])).toEqual([["01.png", T + 10_000]]);
    // THE mutant: writing through publishServerEvent, which calls it activity and leaves a dot.
    const row = app.db.prepare("SELECT last_event_seq AS l, seen_seq AS s, updated_at AS u FROM sessions WHERE id = ?").get(session.id) as Any;
    expect(row.l).toBeGreaterThan(last);
    expect(row).toMatchObject({ s: row.l, u: NOW - DAY });
    c.close();
  });

  it("runs once per home, and a second run over the same history writes nothing again", async () => {
    const { c, session } = await seeded();
    app.db.prepare("INSERT INTO settings (key, value_json) VALUES (?, '{}')").run(MEDIA_BACKFILL_KEY);
    // THE mutant: no key guard — every boot would walk a fortnight of history again.
    expect(await app.sessions.backfillTurnMedia({ now: NOW })).toBe(0);
    expect(await madeOf(c, session.id)).toEqual([]);
    app.db.prepare("DELETE FROM settings WHERE key = ?").run(MEDIA_BACKFILL_KEY);
    expect(await app.sessions.backfillTurnMedia({ now: NOW })).toBe(1);
    // A run cut short before it set the key runs again, and skips the turn it already wrote.
    app.db.prepare("DELETE FROM settings WHERE key = ?").run(MEDIA_BACKFILL_KEY);
    expect(await app.sessions.backfillTurnMedia({ now: NOW })).toBe(0);
    expect(await madeOf(c, session.id)).toHaveLength(1);
    c.close();
  });
});
