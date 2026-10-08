import { describe, expect, it } from "vitest";
import { sessionEvent, type SessionEvent, type StoredSessionEvent } from "@realm/contracts";
import { RowSchema } from "@realm/remote";
import { SessionProjector, summarize } from "./rows";

let seq = 0;
const persisted = (ev: SessionEvent): StoredSessionEvent => ({ seq: ++seq, sessionId: "s", event: ev });
const ephemeral = (ev: SessionEvent): StoredSessionEvent => ({ seq: -1, sessionId: "s", event: ev });

describe("the phone's rows", () => {
  it("streams a message into one row and replaces it with the final text where it stands", () => {
    const p = new SessionProjector();
    p.apply(persisted(sessionEvent("user_message", { text: "hi", attachments: [] })));
    expect(p.apply(ephemeral(sessionEvent("assistant_delta", { messageId: "m1", delta: "Hel" })))).toMatchObject([{ key: "m:m1", text: "Hel", streaming: true }]);
    p.apply(ephemeral(sessionEvent("assistant_delta", { messageId: "m1", delta: "lo" })));
    p.apply(persisted(sessionEvent("assistant_text", { messageId: "m1", text: "Hello." })));
    expect(p.all().map((r) => [r.key.split(":")[0], r.kind === "assistant" || r.kind === "user" ? r.text : ""])).toEqual([["u", "hi"], ["m", "Hello."]]);
    expect(p.all()[1]).toMatchObject({ streaming: false });
  });

  it("turns a tool call and its result into one row that finishes in place", () => {
    const p = new SessionProjector();
    p.apply(persisted(sessionEvent("tool_call", { toolUseId: "t1", name: "Bash", input: { command: "pnpm test\n--silent" }, parentToolUseId: null })));
    expect(p.all()).toMatchObject([{ key: "t:t1", kind: "tool", summary: "pnpm test", state: "running" }]);
    p.apply(persisted(sessionEvent("tool_result", { toolUseId: "t1", content: "x".repeat(5_000), isError: true })));
    const row = p.all()[0]!;
    expect(row).toMatchObject({ state: "error" });
    expect(row.kind === "tool" && row.detail!.length).toBe(2_000);
  });

  it("draws a question as one request card with its options, and answers it in place", () => {
    const p = new SessionProjector();
    const input = { questions: [{ question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite" }] }] };
    p.apply(persisted(sessionEvent("tool_call", { toolUseId: "t1", name: "AskUserQuestion", input, parentToolUseId: null })));
    p.apply(persisted(sessionEvent("permission_request", { requestId: "r1", toolName: "AskUserQuestion", input, title: "Allow AskUserQuestion?", suggestions: [] })));
    expect(p.all()).toHaveLength(1);
    expect(p.all()[0]).toMatchObject({ kind: "request", state: "pending", questions: [{ question: "Which database?", options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite" }] }] });
    p.apply(persisted(sessionEvent("permission_response", { requestId: "r1", decision: "allow" })));
    expect(p.all()[0]).toMatchObject({ state: "allowed" });
  });

  it("ignores a persisted event it has already folded, so history and the live stream can overlap", () => {
    const p = new SessionProjector();
    const ev = persisted(sessionEvent("user_message", { text: "once", attachments: [] }));
    expect(p.apply(ev)).toHaveLength(1);
    expect(p.apply(ev)).toEqual([]);
    expect(p.all()).toHaveLength(1);
  });

  it("every row it makes is a valid mobile.v1 row", () => {
    const p = new SessionProjector();
    const events: SessionEvent[] = [
      sessionEvent("user_message", { text: "go", attachments: [] }),
      sessionEvent("thinking", { messageId: "k1", text: "hmm" }),
      sessionEvent("plan", { planId: "p1", steps: [{ text: "Do it", status: "in_progress" }] }),
      sessionEvent("error", { message: "Usage limit", failure: "usage_limit", fix: { title: "Switch agent", hint: "Use Codex", command: null } }),
      sessionEvent("compacted", { trigger: "auto", preTokens: 100 }),
      sessionEvent("status", { status: "idle" }),
      sessionEvent("usage", { costUsd: 0, inputTokens: 1, outputTokens: 1, numTurns: 1 }),
    ];
    for (const ev of events) p.apply(persisted(ev));
    expect(p.all().map((r) => r.kind)).toEqual(["user", "thinking", "plan", "error", "notice"]);
    for (const r of p.all()) expect(RowSchema.safeParse(r).success, r.kind).toBe(true);
  });

  it("says what a turn changed in one line, by file name", () => {
    const p = new SessionProjector();
    const file = (path: string) => ({ path, oldPath: null, status: "modified" as const, additions: 3, deletions: 1 });
    p.apply(persisted(sessionEvent("turn_changes", { checkpointId: "cp1", settledAt: 1, root: "/r", afterTree: "abc", files: ["src/app.ts", "src/remote/rows.ts", "README.md", "x.ts"].map(file), totalFiles: 4 })));
    p.apply(persisted(sessionEvent("turn_changes", { checkpointId: "cp2", settledAt: 2, root: "/r", afterTree: "def", files: [file("only.ts")], totalFiles: 1 })));
    expect(p.all().map((r) => r.kind === "notice" && r.text)).toEqual(["Changed 4 files: app.ts, rows.ts, README.md, …", "Changed 1 file: only.ts"]);
  });

  it("names a tool call by what it touches", () => {
    expect(summarize("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarize("WebSearch", { query: "noise protocol" })).toBe("noise protocol");
    expect(summarize("mcp__x__y", { url: "https://x" })).toBe("https://x");
    expect(summarize("Mystery", {})).toBe("Mystery");
  });
});
