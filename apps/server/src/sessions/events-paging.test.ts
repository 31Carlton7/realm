import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import { sessionEvent, type StoredSessionEvent } from "@realm/contracts";
import { createApp, type App } from "../app";

/** `sessions.events` read from the end: how a transcript opens on its newest page and pages back. */

let app: App;
afterEach(async () => { await app?.close(); });

async function boot() {
  app = await createApp({ home: tempDir("realm-"), port: 0, adapters: { fake: new FakeAdapter({ script: [] }) } });
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${app.port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: { result?: unknown; error?: unknown }) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    const id = String(++n);
    const reply = await new Promise<{ result?: unknown; error?: unknown }>((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    expect(reply.error).toBeUndefined();
    return reply.result as T;
  };
  const p = await call<{ id: string }>("profiles.create", { name: "W" });
  const sp = await call<{ id: string }>("spaces.create", { profileId: p.id, name: "S" });
  const made = await call<{ session: { id: string } }>("sessions.create", { spaceId: sp.id, agentKind: "fake" });
  return { call, id: made.session.id };
}

describe("sessions.events with beforeSeq", () => {
  it("answers the newest page before the seq, oldest first, and only the kinds asked for", async () => {
    const { call, id } = await boot();
    for (let i = 0; i < 6; i++) {
      app.sessions.emitExternal(id, sessionEvent("user_message", { text: `q${i}`, attachments: [] }));
      app.sessions.emitExternal(id, sessionEvent("assistant_text", { messageId: `m${i}`, text: `a${i}` }));
    }
    const all = await call<StoredSessionEvent[]>("sessions.events", { id, afterSeq: 0, limit: 100 });
    const seqs = all.map((e) => e.seq);

    const tail = await call<StoredSessionEvent[]>("sessions.events", { id, beforeSeq: Number.MAX_SAFE_INTEGER, limit: 4 });
    expect(tail.map((e) => e.seq)).toEqual(seqs.slice(-4));
    const before = await call<StoredSessionEvent[]>("sessions.events", { id, beforeSeq: tail[0]!.seq, limit: 4 });
    expect(before.map((e) => e.seq)).toEqual(seqs.slice(-8, -4));

    const prompts = await call<StoredSessionEvent[]>("sessions.events", { id, beforeSeq: Number.MAX_SAFE_INTEGER, limit: 2, types: ["user_message"] });
    expect(prompts.map((e) => e.event.type === "user_message" && e.event.payload.text)).toEqual(["q4", "q5"]);
    // Without beforeSeq the filter reads forward, like the plain read.
    const first = await call<StoredSessionEvent[]>("sessions.events", { id, afterSeq: 0, limit: 1, types: ["assistant_text"] });
    expect(first.map((e) => e.event.type === "assistant_text" && e.event.payload.text)).toEqual(["a0"]);
  });
});
