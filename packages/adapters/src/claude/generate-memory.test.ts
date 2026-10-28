import { describe, expect, it } from "vitest";
import { BACKGROUND_MODEL } from "./background-model";
import { generateMemoryExtraction, generateMemoryTidyPlan } from "./generate-memory";

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

const TIDY = {
  indexes: [{ path: "MEMORY.md", text: "# Memory\n\n## Index\n- [[spaces/work/MEMORY]]\n" }, { path: "spaces/work/MEMORY.md", text: "- [Owner](owner.md) — Dana owns billing\n" }],
  files: [{ path: "spaces/work/owner.md", text: "---\nname: owner\n---\n\nDana owns billing.\n" }],
};

describe("generateMemoryTidyPlan", () => {
  it("shows every index and fact file by its path from the repo's root", async () => {
    const f = fakeQuery('{"operations": []}');
    await generateMemoryTidyPlan(TIDY, { query: f.query });
    const prompt = f.asked[0]!.prompt;
    expect(prompt).toContain("=== MEMORY.md\n# Memory");
    expect(prompt).toContain("=== spaces/work/MEMORY.md\n- [Owner](owner.md)");
    expect(prompt).toContain("=== spaces/work/owner.md\n---\nname: owner");
  });

  it("names the five operations and asks for JSON only", async () => {
    const f = fakeQuery('{"operations": []}');
    await generateMemoryTidyPlan(TIDY, { query: f.query });
    const guidance = f.asked[0]!.options.systemPrompt!;
    for (const said of ['"op": "merge"', '"op": "rewrite"', '"op": "delete"', '"op": "line"', '"op": "promote"', "at most 20", "nothing else"]) expect(guidance).toContain(said);
  });
});

describe("the background model", () => {
  /* THE MUTANT: either call quietly back on a cheaper model. The owner's rule is never downgrade, for
     background work as for a session, and both calls must move together when the constant does. */
  it("is the one model both background calls run on", async () => {
    const extraction = fakeQuery('{"memories": []}');
    const tidy = fakeQuery('{"operations": []}');
    await generateMemoryExtraction(INPUT, { query: extraction.query });
    await generateMemoryTidyPlan(TIDY, { query: tidy.query });
    expect([extraction.asked[0]!.options.model, tidy.asked[0]!.options.model]).toEqual([BACKGROUND_MODEL, BACKGROUND_MODEL]);
    expect(BACKGROUND_MODEL).toBe("claude-opus-5-5");
  });
});
