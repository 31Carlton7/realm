import { describe, expect, it, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";
import { AcpAdapter } from "@realm/adapters";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

/**
 * Realm's memory reaching an ACP agent, end to end: a real `AcpAdapter` driving the fake ACP agent the
 * adapter suite uses, through the ordinary create-then-send path. The agent writes every
 * `session/prompt` it receives to a file, so what crossed the wire is read here as the agent saw it —
 * and the stored transcript is read over RPC as the renderer reads it.
 */

const FAKE_ACP = fileURLToPath(new URL("../../../../packages/adapters/src/acp/fixtures/fake-acp-agent.mjs", import.meta.url));

let app: App;
afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Block = { type: string; text?: string };

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`rpc ${method} timed out`)); }, 5000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close() };
}

async function boot() {
  const home = tempDir("realm-first-prompt-");
  vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
  const wire = join(home, "prompts.jsonl");
  const gemini = new AcpAdapter({ kind: "acp:gemini", bin: process.execPath, args: [FAKE_ACP], label: "Gemini", loginHint: "", env: { FAKE_ACP_PROMPT_LOG: wire } });
  app = await createApp({ home, port: 0, adapters: { "acp:gemini": gemini }, claudeDir: join(home, "claude-home") });
  const c = await client(app.port);
  const p = (await c.call("profiles.create", { name: "W" })).result;
  const space = (await c.call("spaces.create", { profileId: p.id, name: "A" })).result;
  /** Every prompt the agent has received, in order, as it came over the wire. */
  const prompts = (): Block[][] => (existsSync(wire) ? readFileSync(wire, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Block[]) : []);
  return { c, space, prompts };
}

describe("Realm's memory in an ACP agent's first prompt", () => {
  it("arrives once per agent process, ahead of the user's words, while the transcript keeps only what was typed", async () => {
    const { c, space, prompts } = await boot();
    await c.call("memory.set", { spaceId: space.id, doc: "SPACE_DOC_7731: deploys go out from main." });
    const { session } = (await c.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini" })).result;
    const events = async () => (await c.call("sessions.events", { id: session.id })).result.map((e: Any) => e.event);
    const replies = async () => (await events()).filter((e: Any) => e.type === "assistant_text").length;
    const send = async (text: string) => {
      const before = await replies();
      await c.call("sessions.send", { id: session.id, text });
      await waitFor(async () => (await replies()) > before, { timeout: 10_000 });
    };

    await send("first message");
    await send("second message");
    // A restart: the next send boots a new agent process on the same conversation.
    await app.sessions.stopAgent(session.id);
    await send("third message");
    await send("fourth message");

    const wire = prompts();
    expect(wire.map((p) => p.filter((b) => b.text?.includes("SPACE_DOC_7731")).length)).toEqual([1, 0, 1, 0]);
    const context = wire[0]![0]!;
    expect(context.text).toMatch(/^<realm-context>\n/);
    expect(context.text).toContain("# Space memory");
    // The capabilities preamble reaches an ACP agent through the gateway's instructions, never here too.
    expect(context.text).not.toContain("This session runs in Realm");
    // The user's words, a block of their own, exactly as typed.
    expect(wire.map((p) => p.at(-1))).toEqual(["first message", "second message", "third message", "fourth message"].map((text) => ({ type: "text", text })));
    // The restarted process is sent the same bytes the first one was.
    expect(wire[2]![0]).toEqual(context);

    const stored = await events();
    expect(stored.filter((e: Any) => e.type === "user_message").map((e: Any) => e.payload.text))
      .toEqual(["first message", "second message", "third message", "fourth message"]);
    // THE MUTANT: inject at the server, into the message itself. The context would then be stored and
    // drawn as if the user had typed it.
    expect(JSON.stringify(stored)).not.toContain("realm-context");
    expect(JSON.stringify(stored)).not.toContain("SPACE_DOC_7731");
    c.close();
  }, 30_000);

  it("sends nothing extra where the space has no memory", async () => {
    const { c, space, prompts } = await boot();
    const { session } = (await c.call("sessions.create", { spaceId: space.id, agentKind: "acp:gemini" })).result;
    await c.call("sessions.send", { id: session.id, text: "hello" });
    await waitFor(() => prompts().length === 1, { timeout: 10_000 });
    expect(prompts()).toEqual([[{ type: "text", text: "hello" }]]);
    c.close();
  }, 30_000);
});
