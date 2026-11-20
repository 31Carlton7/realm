import { describe, expect, it } from "vitest";
import { ClaudeLiveAnswers, liveAnswerPrompt } from "./live-answer";

type Options = { model?: string; tools?: string[]; settingSources?: string[]; thinking?: { type: string }; persistSession?: boolean; includePartialMessages?: boolean; abortController?: AbortController };

const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });

/** The SDK's `startup()`: each call is one engine started with `options`, which answers its one
 *  prompt in `pieces`, a piece per tick, and stops early when its abort controller fires. */
function engines(pieces = ["About twelve ", "seats, to start."]) {
  const started: { options: Options; prompts: string[]; closed: boolean }[] = [];
  const startup = (async ({ options }: { options: Options }) => {
    const engine = { options, prompts: [] as string[], closed: false };
    started.push(engine);
    return {
      close: () => { engine.closed = true; },
      query: (prompt: string) => {
        engine.prompts.push(prompt);
        return (async function* () {
          for (const p of pieces) {
            await new Promise((r) => setTimeout(r, 5));
            if (options.abortController?.signal.aborted) return;
            yield delta(p);
          }
          yield { type: "result", subtype: "success", result: pieces.join("") };
        })();
      },
    };
  }) as never;
  return { started, startup };
}

const ask = (model: ClaudeLiveAnswers, opts: { model?: string | null; signal?: AbortSignal } = {}) => {
  const got: string[] = [];
  const done = model.answer({ model: opts.model === undefined ? "claude-haiku-5-5" : opts.model, prompt: "the prompt", signal: opts.signal ?? new AbortController().signal, onText: (d) => got.push(d) });
  return { got, done };
};

describe("ClaudeLiveAnswers", () => {
  it("streams the answer piece by piece and resolves with the whole of it", async () => {
    const { startup } = engines();
    const live = new ClaudeLiveAnswers({ startup });
    const { got, done } = ask(live);
    expect(await done).toBe("About twelve seats, to start.");
    expect(got).toEqual(["About twelve ", "seats, to start."]);
    live.close();
  });

  it("sends the words to the model and nothing else: no tools, no settings, no thinking, not saved", async () => {
    const { started, startup } = engines();
    const live = new ClaudeLiveAnswers({ startup });
    await ask(live).done;
    expect(started[0]!.options).toMatchObject({ model: "claude-haiku-5-5", tools: [], settingSources: [], thinking: { type: "disabled" }, persistSession: false, includePartialMessages: true });
    expect(started[0]!.prompts).toEqual(["the prompt"]);
    live.close();
  });

  it("answers on the engine started ahead of it, and starts the next as it ends", async () => {
    const { started, startup } = engines();
    const live = new ClaudeLiveAnswers({ startup });
    live.prepare("claude-haiku-5-5");
    expect(started).toHaveLength(1);
    await ask(live).done;
    expect(started[0]!.prompts).toEqual(["the prompt"]);
    // One engine per answer, so no answer carries the one before; the next is up already.
    expect(started).toHaveLength(2);
    expect(started[1]!.prompts).toEqual([]);
    await ask(live).done;
    expect(started[1]!.prompts).toEqual(["the prompt"]);
    live.close();
  });

  it("does not answer on an engine started for another model", async () => {
    const { started, startup } = engines();
    const live = new ClaudeLiveAnswers({ startup });
    live.prepare("claude-haiku-5-5");
    await ask(live, { model: "claude-sonnet-5-5" }).done;
    expect(started[0]!.prompts).toEqual([]);
    expect(started[1]!.options.model).toBe("claude-sonnet-5-5");
    expect(started[1]!.prompts).toEqual(["the prompt"]);
    live.close();
  });

  it("leaves the model to the CLI's default when the setting names none", async () => {
    const { started, startup } = engines();
    const live = new ClaudeLiveAnswers({ startup });
    await ask(live, { model: null }).done;
    expect("model" in started[0]!.options).toBe(false);
    live.close();
  });

  it("stops the engine and rejects when the answer is cancelled", async () => {
    const { started, startup } = engines(["one ", "two ", "three"]);
    const live = new ClaudeLiveAnswers({ startup });
    const stop = new AbortController();
    const { got, done } = ask(live, { signal: stop.signal });
    await new Promise((r) => setTimeout(r, 8));
    stop.abort();
    await expect(done).rejects.toThrow("cancelled");
    expect(started[0]!.options.abortController!.signal.aborted).toBe(true);
    expect(got.length).toBeLessThan(3);
    live.close();
  });

  it("stops the engine it kept when it has waited the idle time", async () => {
    const { started, startup } = engines();
    const live = new ClaudeLiveAnswers({ startup, warmMs: 20 });
    live.prepare("claude-haiku-5-5");
    await new Promise((r) => setTimeout(r, 60));
    expect(started[0]!.closed).toBe(true);
    live.close();
  });
});

describe("liveAnswerPrompt", () => {
  it("fences the custom info and the transcript as data, naming who said what", () => {
    const prompt = liveAnswerPrompt({
      lines: [{ source: "them", text: "How many seats do you need?", start: 0, end: 2_000, at: 1 }, { source: "me", text: "Let me check.", start: 2_500, end: 3_000, at: 2 }],
      customInfo: "I'm pitching the annual plan.",
      trigger: "question",
    });
    expect(prompt).toMatch(/<<<untrusted-[0-9a-f]{16}\nI'm pitching the annual plan\.\nuntrusted-[0-9a-f]{16}>>>/);
    expect(prompt).toMatch(/<<<untrusted-[0-9a-f]{16}\nThem: How many seats do you need\?\nMe: Let me check\.\nuntrusted-[0-9a-f]{16}>>>/);
    expect(prompt).toMatch(/just asked the last question/);
  });

  it("says when there is no custom info, and asks for what to say next on the key", () => {
    const prompt = liveAnswerPrompt({ lines: [], customInfo: "  ", trigger: "key" });
    expect(prompt).toMatch(/told you nothing/);
    expect(prompt).toMatch(/asked you for help now/);
  });
});
