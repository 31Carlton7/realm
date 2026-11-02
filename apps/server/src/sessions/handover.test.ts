import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { sessionEvent, type Session, type StoredSessionEvent } from "@realm/contracts";
import type { SessionEventsStore } from "../store/sessions";
import { HandoffNotes, handoffsRoot, modeAfterSwitch, modelNameOf, type HandoffNotesGenerator } from "./handover";

const session = { id: "s1", title: "Health endpoint", cwd: "/work/app" } as Session;
const said = [
  ["user", "add a health endpoint"], ["assistant", "Which path?"], ["user", "use /healthz"], ["assistant", "Added it."],
  ["user", "now test it"], ["assistant", "Tests pass."], ["user", "and the docs"], ["assistant", "Docs updated."],
] as const;

/** The two reads the notes make, over a fixed conversation that edited one file in the checkout. */
function events(): SessionEventsStore {
  const evs = [
    ...said.map(([role, text]) => role === "user"
      ? sessionEvent("user_message", { text, attachments: [] } as never)
      : sessionEvent("assistant_text", { messageId: text, text } as never)),
    sessionEvent("tool_call", { toolUseId: "t1", name: "Write", input: { file_path: "/work/app/src/health.ts", content: "x" } } as never),
    sessionEvent("tool_result", { toolUseId: "t1", content: "ok", isError: false } as never),
  ];
  const stored = evs.map((event, i) => ({ seq: i + 1, sessionId: "s1", event })) as StoredSessionEvent[];
  return {
    listAfter: () => stored,
    transcript: () => said.map(([role, text]) => ({ role, text })),
  } as unknown as SessionEventsStore;
}

const sides = { from: "Claude Opus 5.5", to: "Codex GPT-5.6" };

describe("HandoffNotes", () => {
  it("writes the model's account with Realm's own facts, numbered per switch", async () => {
    const home = tempDir("realm-handover-");
    let asked: Parameters<HandoffNotesGenerator>[0] | null = null;
    const notes = new HandoffNotes({ home, events: events(), available: () => true, now: () => Date.UTC(2026, 10, 2, 14, 3),
      generate: async (input) => { asked = input; return "## The ask\nA health endpoint.\n\n## Current state\nDocs next."; } });
    const first = await notes.write(session, sides);

    expect(first.path).toBe(join(handoffsRoot(home), "s1", "handoff-1.md"));
    const text = readFileSync(first.path, "utf8");
    expect(text).toBe(first.notes);
    expect(text.startsWith("# Health endpoint\n\nSwitched from Claude Opus 5.5 to Codex GPT-5.6 on 2026-11-02")).toBe(true);
    expect(text).toContain("## The ask\nA health endpoint.");
    // The files are counted off the log, relative to the checkout — never asked of the model.
    expect(text).toContain("## Files edited\n\n- `src/health.ts`");
    // The last three asks and their answers, verbatim; the opening turn is the model's to summarise.
    expect(text).toContain("## Last turns\n\n```text\nUser: use /healthz");
    expect(text).not.toContain("User: add a health endpoint");
    expect(asked!.facts).toContain("health.ts");
    expect(asked!.from).toBe("Claude Opus 5.5");

    expect((await notes.write(session, sides)).path).toBe(join(handoffsRoot(home), "s1", "handoff-2.md"));
  });

  it("carries the conversation verbatim when the call fails — never a cheaper model's account", async () => {
    const home = tempDir("realm-handover-");
    const errors: string[] = [];
    const notes = new HandoffNotes({ home, events: events(), available: () => true, onError: (l) => errors.push(l),
      generate: async () => { throw new Error("hand-off notes failed: error_during_execution"); } });
    const { notes: text } = await notes.write(session, sides);
    expect(text).toContain("No summary was written, so the conversation is carried as written.");
    expect(text).toContain("## Conversation\n\n```text\nUser: add a health endpoint");
    expect(errors).toEqual(["[handoff] hand-off notes failed: error_during_execution"]);
  });

  it("asks the machine before it spends anything, and forgets a deleted session's notes", async () => {
    const home = tempDir("realm-handover-");
    let called = false;
    const notes = new HandoffNotes({ home, events: events(), available: () => false, generate: async () => { called = true; return "x"; } });
    await notes.write(session, sides);
    expect(called).toBe(false);
    await notes.release("s1");
    expect(existsSync(join(handoffsRoot(home), "s1"))).toBe(false);
  });
});

describe("naming and moding a switch", () => {
  it("names a model off the live catalog first, the curated list next, the agent's default last", () => {
    const probes = [{ kind: "codex" as const, available: true, version: "1", loggedIn: true, reason: null, models: [{ id: "gpt-5.6", label: "GPT-5.6", isDefault: true }] }];
    expect(modelNameOf("codex", null, probes)).toBe("Codex GPT-5.6");
    expect(modelNameOf("claude", "claude-opus-5-5", [])).toBe("Claude Opus 5.5");
    expect(modelNameOf("codex", "gpt-9", [])).toBe("Codex gpt-9");
  });

  it("keeps a mode the new agent can be put in, and drops one it cannot", () => {
    expect(modeAfterSwitch("codex", "bypassPermissions", "default")).toBe("bypassPermissions");
    expect(modeAfterSwitch("codex", "plan", "default")).toBe("plan");
    expect(modeAfterSwitch("acp:cursor", "bypassPermissions", "default")).toBe("default");
  });
});
