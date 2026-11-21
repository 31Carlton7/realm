import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type LiveAnswerModel, type LiveAnswerRequest } from "@realm/adapters";
import type { LiveAnswerEvent, MeetingTranscriptLine } from "@realm/contracts";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

let app: App;
afterEach(async () => { await app?.close(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  const answers: LiveAnswerEvent[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if ("id" in m) pending.get(m.id)?.(m);
    else if (m.event === "meetings.answer") answers.push(m.payload);
  });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res) => {
    const id = String(++n);
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, answers, close: () => ws.close() };
}

/** A model that answers in two pieces, a tick apart, unless the answer is cancelled first. */
class Model implements LiveAnswerModel {
  asked: LiveAnswerRequest[] = [];
  prepared: (string | null)[] = [];
  released = 0;
  constructor(private hold = 5) {}
  prepare(model: string | null) { this.prepared.push(model); }
  async answer(req: LiveAnswerRequest) {
    this.asked.push(req);
    for (const piece of ["About twelve ", "seats."]) {
      await new Promise((r) => setTimeout(r, this.hold));
      if (req.signal.aborted) throw new Error("cancelled");
      req.onText(piece);
    }
    return "About twelve seats.";
  }
  release() { this.released++; }
  close() {}
}

async function boot(model = new Model()) {
  app = await createApp({ home: tempDir("realm-"), port: 0, adapters: { claude: new FakeAdapter({ script: [] }), fake: new FakeAdapter({ script: [] }) }, liveAnswers: model });
  return { model, c: await client(app.port) };
}

const line = (source: "me" | "them", text: string, start: number, end = start + 2_000): MeetingTranscriptLine => ({ source, text, start, end, at: 1_795_207_765_432 + start });
const question = [line("me", "Thanks for having me.", 0), line("them", "How many seats do you need?", 3_000)];
const settled = (answers: LiveAnswerEvent[], id: string) => answers.some((e) => e.answerId === id && (e.t === "done" || e.t === "error" || e.t === "cancelled"));

describe("meetings.answer", () => {
  it("streams start, the pieces, then done, to the window that asked", async () => {
    const { c } = await boot();
    const { answerId } = (await c.call("meetings.answer", { lines: question, customInfo: "I'm pitching the annual plan.", trigger: "question" })).result;
    await waitFor(() => settled(c.answers, answerId));
    expect(c.answers).toEqual([
      { answerId, t: "start", trigger: "question", model: "claude-haiku-5-5" },
      { answerId, t: "delta", text: "About twelve " },
      { answerId, t: "delta", text: "seats." },
      { answerId, t: "done", text: "About twelve seats." },
    ]);
    c.close();
  });

  it("sends the window and the custom info, and no other window hears the answer", async () => {
    const { model, c } = await boot();
    const other = await client(app.port);
    const lines = [line("them", "Thanks for joining, this is the intro.", 0, 2_000), line("me", "Happy to be here.", 30_000, 32_000), line("them", "How many seats do you need?", 210_000, 212_000)];
    const { answerId } = (await c.call("meetings.answer", { lines, customInfo: "Their CTO doubts the SSO story.", trigger: "key" })).result;
    await waitFor(() => settled(c.answers, answerId));
    const prompt = model.asked[0]!.prompt;
    expect(prompt).toContain("Their CTO doubts the SSO story.");
    expect(prompt).toContain("Me: Happy to be here.\nThem: How many seats do you need?");
    // Three minutes back from the newest line's end: the intro is older than that, and stays here.
    expect(prompt).not.toContain("this is the intro");
    expect(other.answers).toEqual([]);
    other.close();
    c.close();
  });

  it("cancels the answer in flight when a newer question arrives", async () => {
    const { model, c } = await boot(new Model(30));
    const first = (await c.call("meetings.answer", { lines: question, customInfo: "", trigger: "question" })).result.answerId;
    await waitFor(() => model.asked.length === 1);
    const second = (await c.call("meetings.answer", { lines: [...question, line("them", "And when would you start?", 6_000)], customInfo: "", trigger: "question" })).result.answerId;
    await waitFor(() => settled(c.answers, second));
    expect(model.asked[0]!.signal.aborted).toBe(true);
    const ofFirst = c.answers.filter((e) => e.answerId === first).map((e) => e.t);
    expect(ofFirst).toEqual(["start", "cancelled"]);
    expect(c.answers.filter((e) => e.answerId === second).map((e) => e.t)).toEqual(["start", "delta", "delta", "done"]);
    c.close();
  });

  it("stops the answer on cancel", async () => {
    const { model, c } = await boot(new Model(30));
    const { answerId } = (await c.call("meetings.answer", { lines: question, customInfo: "", trigger: "key" })).result;
    await waitFor(() => model.asked.length === 1);
    expect((await c.call("meetings.cancelAnswer", {})).result).toEqual({ ok: true });
    await waitFor(() => settled(c.answers, answerId));
    await new Promise((r) => setTimeout(r, 80));
    expect(c.answers.filter((e) => e.answerId === answerId).map((e) => e.t)).toEqual(["start", "cancelled"]);
    expect(model.asked[0]!.signal.aborted).toBe(true);
    c.close();
  });

  it("cancels the answer and lets the engine go when the meeting stops", async () => {
    const { model, c } = await boot(new Model(30));
    const { answerId } = (await c.call("meetings.answer", { lines: question, customInfo: "", trigger: "key" })).result;
    await waitFor(() => model.asked.length === 1);
    expect((await c.call("meetings.stopAnswers", {})).result).toEqual({ ok: true });
    await waitFor(() => settled(c.answers, answerId));
    expect(c.answers.filter((e) => e.answerId === answerId).map((e) => e.t)).toEqual(["start", "cancelled"]);
    expect(model.asked[0]!.signal.aborted).toBe(true);
    expect(model.released).toBe(1);
    c.close();
  });

  it("takes custom info of any length", async () => {
    const { model, c } = await boot();
    const { answerId } = (await c.call("meetings.answer", { lines: question, customInfo: "brief ".repeat(10_000), trigger: "key" })).result;
    await waitFor(() => settled(c.answers, answerId));
    expect(model.asked[0]!.prompt).toContain("brief ".repeat(10_000).trim());
    c.close();
  });

  it("sends nothing more of a cancelled answer, even from a model that keeps going", async () => {
    class Deaf extends Model {
      override async answer(req: LiveAnswerRequest) {
        this.asked.push(req);
        for (const piece of ["one ", "two ", "three"]) { await new Promise((r) => setTimeout(r, 20)); req.onText(piece); }
        return "one two three";
      }
    }
    const { model, c } = await boot(new Deaf());
    const { answerId } = (await c.call("meetings.answer", { lines: question, customInfo: "", trigger: "key" })).result;
    await waitFor(() => model.asked.length === 1);
    await c.call("meetings.cancelAnswer", {});
    await new Promise((r) => setTimeout(r, 120));
    expect(c.answers.filter((e) => e.answerId === answerId).map((e) => e.t)).toEqual(["start", "cancelled"]);
    c.close();
  });

  it("answers on the model the Quick chat model setting names", async () => {
    const { model, c } = await boot();
    await c.call("settings.set", { key: "quickChatModel", value: { agentKind: "claude", model: "claude-sonnet-5-5" } });
    const { answerId } = (await c.call("meetings.answer", { lines: question, customInfo: "", trigger: "key" })).result;
    await waitFor(() => settled(c.answers, answerId));
    expect(model.asked[0]!.model).toBe("claude-sonnet-5-5");
    expect(c.answers[0]).toMatchObject({ t: "start", model: "claude-sonnet-5-5" });
    expect((await c.call("meetings.prepareAnswers", {})).result).toEqual({ ok: true });
    expect(model.prepared).toEqual(["claude-sonnet-5-5"]);
    c.close();
  });

  it("says so, and asks no model, when the setting names another agent", async () => {
    const { model, c } = await boot();
    await c.call("settings.set", { key: "quickChatModel", value: { agentKind: "fake", model: "fake" } });
    const { answerId } = (await c.call("meetings.answer", { lines: question, customInfo: "", trigger: "key" })).result;
    await waitFor(() => settled(c.answers, answerId));
    expect(c.answers).toEqual([{ answerId, t: "error", message: "Live answers run on Claude, and the Quick chat model is set to fake." }]);
    await c.call("meetings.prepareAnswers", {});
    expect(model.asked).toEqual([]);
    expect(model.prepared).toEqual([]);
    c.close();
  });

  it("takes only lines and custom info", async () => {
    const { model, c } = await boot();
    const refused = await c.call("meetings.answer", { lines: question, customInfo: "", trigger: "key", screen: "base64…" });
    expect(refused.error).toBeTruthy();
    expect(model.asked).toEqual([]);
    c.close();
  });
});
