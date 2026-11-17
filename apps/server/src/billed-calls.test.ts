import { describe, expect, it } from "vitest";
import { generateHandoffNotes, generateMemoryExtraction, generateMemoryTidyPlan, generateSessionRecap, generateSessionTitle } from "@realm/adapters";
import { billedGenerators } from "./billed-calls";

describe("the server's billed model calls", () => {
  it("are wired for a real launch", () => {
    expect(billedGenerators({})).toEqual({
      titleGenerator: generateSessionTitle, summaryGenerator: generateSessionRecap, handoffGenerator: generateHandoffNotes,
      memoryLearning: { extract: generateMemoryExtraction, tidy: generateMemoryTidyPlan },
    });
  });

  it("are not wired at all when the scripted agent is on — a harness makes no billed call", () => {
    // THE BUG: live checks boot the built server, so each one titled and recapped its scratch
    // session on the user's own model account, and left the transcripts in ~/.claude/projects.
    // Memory learning and tidying are the same kind of call: a harness must never make either on the
    // user's account.
    expect(billedGenerators({ REALM_ENABLE_FAKE_AGENT: "1" })).toEqual({});
  });

  it("give a live check a scripted recap only when it asks for one", async () => {
    const { summaryGenerator, ...rest } = billedGenerators({ REALM_ENABLE_FAKE_AGENT: "1", REALM_FAKE_RECAP: "1" });
    expect(rest).toEqual({});
    expect(summaryGenerator).not.toBe(generateSessionRecap);
    await expect(summaryGenerator!({ asked: "x", transcript: "", facts: "- the user wrote 2 times\n- ran 1 command" }))
      .resolves.toEqual({ summary: "Scripted recap: the user wrote 2 times, ran 1 command.", hint: null });
    // Never outside the scripted agent: a real launch with the flag set still gets the real call.
    expect(billedGenerators({ REALM_FAKE_RECAP: "1" }).summaryGenerator).toBe(generateSessionRecap);
  });
});
