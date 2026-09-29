import { describe, expect, it } from "vitest";
import { generateSessionRecap, generateSessionTitle } from "@realm/adapters";
import { billedGenerators } from "./billed-calls";

describe("the server's billed model calls", () => {
  it("are wired for a real launch", () => {
    expect(billedGenerators({})).toEqual({ titleGenerator: generateSessionTitle, summaryGenerator: generateSessionRecap });
  });

  it("are not wired at all when the scripted agent is on — a harness makes no billed call", () => {
    // THE BUG: live checks boot the built server, so each one titled and recapped its scratch
    // session on the user's own model account, and left the transcripts in ~/.claude/projects.
    expect(billedGenerators({ REALM_ENABLE_FAKE_AGENT: "1" })).toEqual({});
  });
});
