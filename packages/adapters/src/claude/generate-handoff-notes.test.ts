import { describe, expect, it } from "vitest";
import { BACKGROUND_MODEL } from "./background-model";
import { cleanNotes, generateHandoffNotes } from "./generate-handoff-notes";

const input = { title: "Health endpoint", asked: "add a health endpoint", transcript: "User: add a health endpoint\nAssistant: done", facts: "- edited 1 file: health.ts", from: "Claude Opus 5.5", to: "Codex GPT-5.6" };

describe("generateHandoffNotes", () => {
  it("runs on the background model, with no tools and one turn, naming both sides", async () => {
    let seen: { prompt: string; options: { model: string; maxTurns: number; allowedTools: string[]; systemPrompt: string } } | null = null;
    const query = ((args: never) => { seen = args; return (async function* () { yield { type: "result", subtype: "success", result: "## The ask\nA health endpoint." }; })(); }) as never;
    const notes = await generateHandoffNotes(input, { query });
    expect(notes).toBe("## The ask\nA health endpoint.");
    expect(seen!.options.model).toBe(BACKGROUND_MODEL);
    expect(seen!.options.maxTurns).toBe(1);
    expect(seen!.options.allowedTools).toEqual([]);
    expect(seen!.options.systemPrompt).toContain("from Claude Opus 5.5 to Codex GPT-5.6");
    expect(seen!.prompt).toContain("- edited 1 file: health.ts");
  });

  it("throws on a failed or empty call, so the caller carries the conversation verbatim instead", async () => {
    const failed = (() => (async function* () { yield { type: "result", subtype: "error_max_turns", result: "" }; })()) as never;
    await expect(generateHandoffNotes(input, { query: failed })).rejects.toThrow(/failed/);
    const empty = (() => (async function* () { yield { type: "result", subtype: "success", result: "  " }; })()) as never;
    await expect(generateHandoffNotes(input, { query: empty })).rejects.toThrow(/empty/);
  });
});

describe("cleanNotes", () => {
  it("unwraps a fence around the whole reply and drops a preamble before the first heading", () => {
    expect(cleanNotes("```markdown\n## The ask\nX\n```")).toBe("## The ask\nX");
    expect(cleanNotes("Here is the hand-off:\n\n## The ask\nX")).toBe("## The ask\nX");
    expect(cleanNotes("## The ask\nX")).toBe("## The ask\nX");
  });
});
