import { describe, expect, it } from "vitest";
import { BACKGROUND_MODEL } from "./background-model";
import { generateMemoryExtraction } from "./generate-memory";

type Asked = { prompt: string; options: { model?: string; maxTurns?: number; allowedTools?: string[]; systemPrompt?: string } };

/** A stand-in for the SDK's `query()` that records what it was asked and yields one `result`. */
function fakeQuery(result: string, subtype = "success") {
  const asked: Asked[] = [];
  const query = ((a: Asked) => { asked.push(a); return (async function* () { yield { type: "result", subtype, result }; })(); }) as never;
  return { query, asked };
}

const INPUT = {
  transcript: "User: Dana owns billing\nAssistant: Noted.",
  known: [{ label: "About the person", index: "- Works in TypeScript\n" }, { label: "This space", index: "" }],
  agentSaved: false,
};

describe("generateMemoryExtraction", () => {
  it("runs on the background model — the owner's never-downgrade rule — as a one-shot with no tools", async () => {
    expect(BACKGROUND_MODEL).toBe("claude-opus-5-5");
    const f = fakeQuery('{"memories": []}');
    await generateMemoryExtraction(INPUT, { query: f.query });
    expect(f.asked[0]!.options).toMatchObject({ model: BACKGROUND_MODEL, maxTurns: 1, allowedTools: [] });
  });

  it("returns the answer as written, for the caller to validate", async () => {
    const f = fakeQuery('```json\n{"memories": []}\n```');
    expect(await generateMemoryExtraction(INPUT, { query: f.query })).toBe('```json\n{"memories": []}\n```');
  });

  it("shows the model what is already known, whether the agent saved, and the conversation", async () => {
    const f = fakeQuery('{"memories": []}');
    await generateMemoryExtraction(INPUT, { query: f.query });
    const prompt = f.asked[0]!.prompt;
    expect(prompt).toContain("About the person:\n- Works in TypeScript");
    // An empty index is not listed as if it said something.
    expect(prompt).not.toContain("This space:");
    expect(prompt).toContain("did not save anything");
    expect(prompt).toContain("User: Dana owns billing\nAssistant: Noted.");
  });

  it("tells the model when the session's agent already saved, so it adds only what was missed", async () => {
    const f = fakeQuery('{"memories": []}');
    await generateMemoryExtraction({ ...INPUT, agentSaved: true }, { query: f.query });
    expect(f.asked[0]!.prompt).toContain("already saved memories itself");
  });

  it("says what is worth keeping and what is not, in the system prompt", async () => {
    const f = fakeQuery('{"memories": []}');
    await generateMemoryExtraction(INPUT, { query: f.query });
    const guidance = f.asked[0]!.options.systemPrompt!;
    for (const said of ["preferences", "with the reason", "decisions", "roles", "git history", "half-finished", "secrets", "at most 5"]) {
      expect(guidance).toContain(said);
    }
  });

  it("throws when the call fails or comes back empty", async () => {
    await expect(generateMemoryExtraction(INPUT, { query: fakeQuery("", "error_max_turns").query })).rejects.toThrow(/error_max_turns/);
    await expect(generateMemoryExtraction(INPUT, { query: fakeQuery("  ").query })).rejects.toThrow(/returned nothing/);
  });
});
