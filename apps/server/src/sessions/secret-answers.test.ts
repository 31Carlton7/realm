import { describe, expect, it } from "vitest";
import { AskCardSchema, HIDDEN_ANSWER, sessionEvent } from "@realm/contracts";
import { SecretAnswers } from "./secret-answers";

const card = AskCardSchema.parse({ asker: { kind: "agent", name: "Codex" }, mode: "question", questions: [
  { id: "key", prompt: "Deploy token?", kind: "text", secret: true },
  { id: "name", prompt: "Name?", kind: "text" },
] });

describe("SecretAnswers — a masked answer reaches the asker and never the log", () => {
  it("scrubs a masked answer from anywhere in an event, and leaves the rest of it alone", () => {
    const s = new SecretAnswers();
    s.rememberFrom("s1", card, { key: "tok_live_123", name: "Ada" });
    const ev = sessionEvent("tool_call", { toolUseId: "t1", name: "Bash", input: { command: "deploy --token tok_live_123", env: ["X=tok_live_123"] }, parentToolUseId: null });
    const out = s.scrub("s1", ev);
    expect(out.type === "tool_call" && out.payload.input).toEqual({ command: `deploy --token ${HIDDEN_ANSWER}`, env: [`X=${HIDDEN_ANSWER}`] });
    // An answer that was not masked is the user's ordinary words, kept as said.
    expect(s.scrubText("s1", "Hello Ada")).toBe("Hello Ada");
  });

  it("is scoped to the session that was told, and hands back the same event when nothing changes", () => {
    const s = new SecretAnswers();
    s.rememberFrom("s1", card, { key: "tok_live_123" });
    const ev = sessionEvent("assistant_text", { messageId: "m", text: "tok_live_123" });
    expect(s.scrub("s2", ev)).toBe(ev);
    const plain = sessionEvent("assistant_text", { messageId: "m", text: "nothing here" });
    expect(s.scrub("s1", plain)).toBe(plain);
    s.forget("s1");
    expect(s.scrub("s1", ev)).toBe(ev);
  });

  it("does not shred ordinary text over a value too short to be a secret", () => {
    const s = new SecretAnswers();
    s.rememberFrom("s1", card, { key: "ab" });
    expect(s.scrubText("s1", "about abc")).toBe("about abc");
  });

  it("replaces a secret that contains another one whole", () => {
    const s = new SecretAnswers();
    s.remember("s1", "tok_1"); s.remember("s1", "tok_1234");
    expect(s.scrubText("s1", "tok_1234")).toBe(HIDDEN_ANSWER);
  });
});
