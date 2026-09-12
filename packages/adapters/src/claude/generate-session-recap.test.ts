import { describe, expect, it } from "vitest";
import { HINT_MAX } from "./generate-prompt-hint";
import { SUMMARY_MAX } from "./generate-session-summary";
import { generateSessionRecap, splitRecap } from "./generate-session-recap";

/** A stand-in for the SDK's `query()`: yields one `result` message and nothing else. */
const fakeQuery = (result: string, subtype = "success") =>
  (() => (async function* () { yield { type: "result", subtype, result }; })()) as never;

const INPUT = { asked: "audit the mappers", transcript: "User: audit the mappers\nAssistant: three drop fields", facts: "3 files read" };

/**
 * Splitting the model's two labelled lines.
 *
 * The tolerance here is not politeness — a model told "no markdown" still reaches for `**SUMMARY:**`
 * now and then, and failing a good summary over a stray asterisk would be paying for a call and then
 * throwing it away.
 */
describe("splitRecap", () => {
  it("reads the two labelled lines", () => {
    expect(splitRecap("SUMMARY: You asked for an audit. Three mappers drop fields.\nHINT: Fix the three mappers."))
      .toEqual({ summary: "You asked for an audit. Three mappers drop fields.", hint: "Fix the three mappers." });
  });

  it("survives the markdown a model adds after being told not to", () => {
    expect(splitRecap("**SUMMARY:** You asked. It answered.\n**HINT:** Ship it.").hint).toBe("Ship it.");
  });

  it("does not care which line came first", () => {
    const r = splitRecap("HINT: Ship it.\nSUMMARY: You asked. It answered.");
    expect(r.summary).toBe("You asked. It answered.");
    expect(r.hint).toBe("Ship it.");
  });

  /* A decline is the common answer, and it must not cost the summary that came back beside it — that
     is the whole risk of folding two calls into one, and this is the assertion that pins it. */
  it("keeps the summary when the hint declines", () => {
    const r = splitRecap("SUMMARY: You said hello. It said hello back.\nHINT: NONE");
    expect(r.summary).toBe("You said hello. It said hello back.");
    expect(r.hint).toBeNull();
  });

  it("keeps the summary when the hint is unusable, rather than failing both", () => {
    // Over the ceiling: the hint is discarded (it would be SENT), the summary is not.
    const long = "x".repeat(HINT_MAX + 20);
    const r = splitRecap(`SUMMARY: You asked. It answered.\nHINT: ${long}`);
    expect(r.summary).toBe("You asked. It answered.");
    expect(r.hint).toBeNull();
  });

  it("keeps the summary when the hint line is missing entirely", () => {
    expect(splitRecap("SUMMARY: You asked. It answered.")).toEqual({ summary: "You asked. It answered.", hint: null });
  });

  /* A model that ignores the format returns bare prose. That shape is a summary, and salvaging it
     beats discarding a call that was already paid for. */
  it("reads an unlabelled answer as summary-only", () => {
    expect(splitRecap("You asked for an audit and three mappers turned out to drop fields."))
      .toEqual({ summary: "You asked for an audit and three mappers turned out to drop fields.", hint: null });
  });

  it("throws only when there is no summary to be had", () => {
    expect(() => splitRecap("")).toThrow(/no summary/);
    expect(() => splitRecap("HINT: Ship it.")).toThrow(/no summary/);
  });

  it("clips an over-long summary to whole sentences, as the summary always did", () => {
    const r = splitRecap(`SUMMARY: ${"word ".repeat(200)}\nHINT: Ship it.`);
    expect(r.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(r.hint).toBe("Ship it.");
  });
});

describe("generateSessionRecap", () => {
  it("makes ONE call for both fields — which is the point of the fold", async () => {
    let calls = 0;
    const query = (() => { calls += 1; return (async function* () {
      yield { type: "result", subtype: "success", result: "SUMMARY: You asked. It answered.\nHINT: Ship it." };
    })(); }) as never;
    const r = await generateSessionRecap(INPUT, { query });
    expect(calls).toBe(1);
    expect(r).toEqual({ summary: "You asked. It answered.", hint: "Ship it." });
  });

  it("asks the cheapest model, no tools, one turn — a recap is priced as a nicety", async () => {
    let seen: Record<string, unknown> = {};
    const query = ((args: { options: Record<string, unknown> }) => {
      seen = args.options;
      return (async function* () { yield { type: "result", subtype: "success", result: "SUMMARY: a. b.\nHINT: NONE" }; })();
    }) as never;
    await generateSessionRecap(INPUT, { query });
    expect(seen.model).toBe("claude-haiku-4-5");
    expect(seen.maxTurns).toBe(1);
    expect(seen.allowedTools).toEqual([]);
  });

  /* Both briefs have to survive in one prompt. Each line asserted here is a failure one of the two
     fields already hit: a summary that recounted, a hint written ABOUT the user instead of AS them,
     and a hint that was generic rather than absent. */
  it("carries both briefs, including the two rules each field learned the hard way", async () => {
    let prompt = "";
    const query = ((args: { options: { systemPrompt: string } }) => {
      prompt = args.options.systemPrompt;
      return (async function* () { yield { type: "result", subtype: "success", result: "SUMMARY: a. b.\nHINT: NONE" }; })();
    }) as never;
    await generateSessionRecap(INPUT, { query });
    expect(prompt).toContain("SUMMARY:");
    expect(prompt).toContain("HINT:");
    expect(prompt).toMatch(/never\s+invent your own/);   // the counts are handed in, not recounted
    expect(prompt).toContain("as them");                  // the hint is the user's own next message
    expect(prompt).toMatch(/[Nn]ever quote/);
    expect(prompt).toContain("NONE");
    expect(prompt).toContain(String(SUMMARY_MAX));
    expect(prompt).toContain(String(HINT_MAX));
  });

  it("hands the counts over as facts rather than asking for them", async () => {
    let prompt = "";
    const query = ((args: { prompt: string }) => {
      prompt = args.prompt;
      return (async function* () { yield { type: "result", subtype: "success", result: "SUMMARY: a. b.\nHINT: NONE" }; })();
    }) as never;
    await generateSessionRecap(INPUT, { query });
    expect(prompt).toContain("3 files read");
    expect(prompt).toContain("do not recount");
    expect(prompt).toContain("audit the mappers");
  });

  it("shows the model the END of a long transcript", async () => {
    let prompt = "";
    const query = ((args: { prompt: string }) => {
      prompt = args.prompt;
      return (async function* () { yield { type: "result", subtype: "success", result: "SUMMARY: a. b.\nHINT: NONE" }; })();
    }) as never;
    await generateSessionRecap({ ...INPUT, transcript: `${"x".repeat(20_000)}\nUser: the last thing said` }, { query });
    expect(prompt).toContain("the last thing said");
    expect(prompt.length).toBeLessThan(20_000);
  });

  it("throws on a non-success result rather than publishing a blank recap", async () => {
    await expect(generateSessionRecap(INPUT, { query: fakeQuery("x", "error_max_turns") }))
      .rejects.toThrow(/recap generation failed/);
  });
});
