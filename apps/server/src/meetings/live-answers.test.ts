import fs from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  const home = tempDir("realm-");
  app = await createApp({ home, port: 0, adapters: { claude: new FakeAdapter({ script: [] }), fake: new FakeAdapter({ script: [] }) }, liveAnswers: model });
  return { model, home, c: await client(app.port) };
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

  it("puts a typed question in the prompt, on the answer key", async () => {
    const { model, c } = await boot();
    const { answerId } = (await c.call("meetings.answer", { lines: question, customInfo: "", trigger: "key", question: "What did we quote them last year?" })).result;
    await waitFor(() => settled(c.answers, answerId));
    expect(c.answers[0]).toMatchObject({ t: "start", trigger: "key" });
    expect(model.asked[0]!.prompt).toMatch(/\nTHE PERSON TYPED THIS TO YOU DURING THE CALL:\nWhat did we quote them last year\?\n\nAnswer what they typed/);
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
    const refused = await c.call("meetings.answer", { lines: question, customInfo: "", trigger: "key", audio: "base64…" });
    expect(refused.error).toBeTruthy();
    expect(model.asked).toEqual([]);
    c.close();
  });
});

/** A PNG header, then a tail of bytes found nowhere else, to look for wherever the picture might
 *  have gone. */
function picture() {
  const head = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
  const tail = Buffer.from(Array.from({ length: 3_000 }, (_, i) => (i * 37 + 11) % 251));
  const data = Buffer.concat([head, tail]).toString("base64");
  return { screen: { mediaType: "image/png" as const, data }, tail, marker: data.slice(-400, -40) };
}

/** Every file under `dir`, read whole. */
const filesUnder = (dir: string): Buffer[] => readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name)));

describe("meetings.answer with a picture of the screen", () => {
  it("sends the picture to the model beside the prompt, and none of it in the answer's events", async () => {
    const { model, c } = await boot();
    const { screen, marker } = picture();
    const { answerId } = (await c.call("meetings.answer", { lines: question, customInfo: "I'm pitching the annual plan.", trigger: "screen", screen })).result;
    await waitFor(() => settled(c.answers, answerId));
    expect(model.asked[0]!.screen).toEqual(screen);
    expect(model.asked[0]!.prompt).toContain("They asked you to read their screen and help now.");
    expect(c.answers.map((e) => e.t)).toEqual(["start", "delta", "delta", "done"]);
    expect(c.answers[0]).toMatchObject({ trigger: "screen" });
    expect(JSON.stringify(c.answers)).not.toContain(marker);
    c.close();
  });

  it("answers a typed question from the screen", async () => {
    const { model, c } = await boot();
    const { screen } = picture();
    const { answerId } = (await c.call("meetings.answer", { lines: question, customInfo: "", trigger: "screen", question: "Which plan is on my slide?", screen })).result;
    await waitFor(() => settled(c.answers, answerId));
    expect(model.asked[0]!.prompt).toMatch(/Which plan is on my slide\?\n\nAnswer what they typed, using what is on their screen, the transcript and what they told you\.$/);
    c.close();
  });

  it("asks the model with no picture at all when none is sent", async () => {
    const { model, c } = await boot();
    const { answerId } = (await c.call("meetings.answer", { lines: question, customInfo: "", trigger: "key" })).result;
    await waitFor(() => settled(c.answers, answerId));
    expect("screen" in model.asked[0]!).toBe(false);
    c.close();
  });

  it("refuses a screen ask without its picture, a picture on another trigger, and a picture over the limits, leaving the answer in flight be", async () => {
    const { model, c } = await boot(new Model(30));
    const { screen } = picture();
    const inFlight = (await c.call("meetings.answer", { lines: question, customInfo: "", trigger: "key" })).result.answerId;
    await waitFor(() => model.asked.length === 1);
    const huge = Buffer.alloc(7_600_000);
    Buffer.from(screen.data, "base64").copy(huge);
    const wide = Buffer.from(screen.data, "base64");
    wide.writeUInt32BE(9_000, 16);
    const refusals = await Promise.all([
      c.call("meetings.answer", { lines: question, customInfo: "", trigger: "screen" }),
      c.call("meetings.answer", { lines: question, customInfo: "", trigger: "key", screen }),
      c.call("meetings.answer", { lines: question, customInfo: "", trigger: "screen", screen: { mediaType: "image/png", data: huge.toString("base64") } }),
      c.call("meetings.answer", { lines: question, customInfo: "", trigger: "screen", screen: { mediaType: "image/png", data: wide.toString("base64") } }),
    ]);
    expect(refusals.map((r) => [r.error.code, r.error.message])).toEqual([
      ["BAD_REQUEST", "A screen answer needs the picture of the screen."],
      ["BAD_REQUEST", "A picture of the screen goes only with the screen trigger."],
      ["BAD_REQUEST", "The screen picture is 7.6 MB, and the Claude API takes pictures up to 7.5 MB (10 MB once base64-encoded). Scale it down or send it as a JPEG, then ask again."],
      ["BAD_REQUEST", "The screen picture is 9000×1 pixels, and the Claude API takes pictures up to 8000 pixels on a side. Scale it down, then ask again."],
    ]);
    await waitFor(() => settled(c.answers, inFlight));
    expect(c.answers.filter((e) => e.answerId === inFlight).map((e) => e.t)).toEqual(["start", "delta", "delta", "done"]);
    expect(model.asked).toHaveLength(1);
    c.close();
  });

  it("takes a picture at the limit through the socket", async () => {
    const { model, c } = await boot();
    const { screen } = picture();
    const big = Buffer.alloc(7_500_000);
    Buffer.from(screen.data, "base64").copy(big);
    const data = big.toString("base64");
    const { answerId } = (await c.call("meetings.answer", { lines: [], customInfo: "", trigger: "screen", screen: { mediaType: "image/png", data } })).result;
    await waitFor(() => settled(c.answers, answerId));
    expect(model.asked[0]!.screen!.data).toBe(data);
    c.close();
  });

  it("refuses a picture that is not a PNG or a JPEG, by its type or by its bytes", async () => {
    const { model, c } = await boot();
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1").toString("base64");
    const refusals = await Promise.all([
      c.call("meetings.answer", { lines: [], customInfo: "", trigger: "screen", screen: { mediaType: "image/gif", data: gif } }),
      c.call("meetings.answer", { lines: [], customInfo: "", trigger: "screen", screen: { mediaType: "image/png", data: gif } }),
    ]);
    expect(refusals[0].error.code).toBe("INVALID_PARAMS");
    expect(refusals[1].error).toEqual({ code: "BAD_REQUEST", message: "The screen picture is not a PNG or a JPEG. Send the capture as one of those." });
    expect(model.asked).toEqual([]);
    c.close();
  });

  it("writes none of the picture to disk or to a log", async () => {
    const { model, home, c } = await boot();
    const { screen, tail, marker } = picture();
    const holds = (arg: unknown): boolean => typeof arg === "string" ? arg.includes(marker)
      : arg instanceof Uint8Array ? Buffer.from(arg).includes(tail) || Buffer.from(arg).toString("latin1").includes(marker)
      : false;
    const watched = [
      ...(["writeFileSync", "writeFile", "appendFileSync", "appendFile", "writeSync", "write", "createWriteStream"] as const).map((n) => [`fs.${n}`, vi.spyOn(fs, n)] as const),
      ...(["writeFile", "appendFile"] as const).map((n) => [`fs.promises.${n}`, vi.spyOn(fs.promises, n)] as const),
      ...(["log", "info", "warn", "error", "debug"] as const).map((n) => [`console.${n}`, vi.spyOn(console, n)] as const),
      ["process.stderr.write", vi.spyOn(process.stderr, "write")] as const,
      ["process.stdout.write", vi.spyOn(process.stdout, "write")] as const,
    ];
    // So code that imported `writeFileSync` and the rest by name calls the spies too.
    syncBuiltinESMExports();
    let caught: string[];
    try {
      const { answerId } = (await c.call("meetings.answer", { lines: question, customInfo: "", trigger: "screen", screen })).result;
      await waitFor(() => settled(c.answers, answerId));
      // And a refused one, whose message is the likeliest place for it to leak.
      const wide = Buffer.from(screen.data, "base64");
      wide.writeUInt32BE(9_000, 16);
      await c.call("meetings.answer", { lines: question, customInfo: "", trigger: "screen", screen: { mediaType: "image/png", data: wide.toString("base64") } });
      expect(model.asked).toHaveLength(1);
    } finally {
      caught = watched.filter(([, spy]) => spy.mock.calls.some((args) => (args as unknown[]).some(holds))).map(([where]) => where);
      for (const [, spy] of watched) spy.mockRestore();
      syncBuiltinESMExports();
    }
    c.close();
    await app.close();
    app = undefined as never;
    expect(caught).toEqual([]);
    expect(filesUnder(home).filter((f) => f.includes(tail) || f.toString("latin1").includes(marker))).toEqual([]);
  });
});
