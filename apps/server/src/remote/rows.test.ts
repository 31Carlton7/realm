import { describe, expect, it } from "vitest";
import { goalContinuationPrompt, goalTurnLabel, moveFailedSentence, movedSentence, sessionEvent, type SessionEvent, type StoredSessionEvent } from "@realm/contracts";
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

  it("says where a sent terminal card runs, from ~, and the name of its program", () => {
    const p = new SessionProjector({ attachmentsDir: null, home: "/Users/me" });
    p.apply(persisted(sessionEvent("user_message", { text: "look", attachments: [], tabs: [
      { itemId: "t1", kind: "terminal", title: "realm", cwd: "/Users/me/code/realm", program: "vim", bytes: 12, truncated: false },
    ] })));
    expect(p.all()[0]).toMatchObject({ tabs: [{ itemId: "t1", cwd: "~/code/realm", program: "vim" }] });
    expect(RowSchema.safeParse(p.all()[0]).success).toBe(true);
  });

  it("draws the tabs a message handed over as cards, by what they came to and never what was read", () => {
    const p = new SessionProjector();
    p.apply(persisted(sessionEvent("user_message", { text: "compare these", attachments: [], tabs: [
      { itemId: "b1", kind: "browser", title: "Pricing", url: "https://example.com/pricing", bytes: 2048, truncated: false },
      { itemId: "t1", kind: "terminal", title: "zsh", bytes: 0, truncated: false, closed: true },
    ] })));
    const row = p.all()[0]!;
    expect(row).toMatchObject({ kind: "user", text: "compare these", tabs: [
      { itemId: "b1", kind: "browser", title: "Pricing", url: "https://example.com/pricing", bytes: 2048, truncated: false },
      { itemId: "t1", kind: "terminal", title: "zsh", bytes: 0, truncated: false, closed: true },
    ] });
    expect(RowSchema.safeParse(row).success).toBe(true);
    p.apply(persisted(sessionEvent("user_message", { text: "no tabs", attachments: [] })));
    expect(p.all()[1]).not.toHaveProperty("tabs");
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

  it("says what a turn made in one line, by file name, once per turn", () => {
    const p = new SessionProjector();
    const media = (name: string) => ({ path: `/Users/me/Desktop/${name}`, size: 1024 });
    p.apply(persisted(sessionEvent("files_made", { settledAt: 7, files: ["shot.png", "chart.pdf", "clip.mp4", "more.png"].map(media), totalFiles: 5 })));
    p.apply(persisted(sessionEvent("files_made", { settledAt: 9, files: [media("icon.png")], totalFiles: 1 })));
    expect(p.all().map((r) => r.kind === "notice" && r.text)).toEqual(["Made 5 files: shot.png, chart.pdf, clip.mp4, …", "Made 1 file: icon.png"]);
    for (const r of p.all()) expect(RowSchema.safeParse(r).success).toBe(true);
  });

  it("draws a question from Realm's own card: several picks, words of your own, a secret, and an answer key that is not the prompt", () => {
    const p = new SessionProjector();
    const ask = {
      asker: { kind: "server" as const, name: "Linear" }, mode: "form" as const, message: "To file the issue",
      questions: [
        { id: "team", prompt: "Which team?", kind: "choice" as const, options: [{ value: "eng", label: "Engineering", description: "Builds it" }, { value: "ops", label: "Operations" }], allowOther: true },
        { id: "labels", prompt: "Which labels?", header: "Labels", kind: "multi" as const, options: [{ value: "bug", label: "bug" }, { value: "p1", label: "p1" }] },
        { id: "token", prompt: "Paste the deploy token", kind: "text" as const, secret: true, required: true, placeholder: "tok_…" },
        { id: "ship", prompt: "Ship it now?", kind: "confirm" as const, default: "no" },
      ],
    };
    p.apply(persisted(sessionEvent("permission_request", { requestId: "q1", toolName: "mcp__linear__create", input: {}, title: "Linear asks", suggestions: [], ask })));
    const [row] = p.all();
    expect(RowSchema.safeParse(row).success).toBe(true);
    expect(row).toMatchObject({ kind: "request", asker: "Linear's MCP server", message: "To file the issue" });
    // THE MUTANTS: read questions off the tool's name (an MCP form is no `AskUserQuestion`), or drop
    // the card's id, multi-select, words-of-your-own or secret, and the phone answers it wrongly.
    expect(row?.kind === "request" && row.questions).toEqual([
      { question: "Which team?", header: "", multiSelect: false, id: "team", kind: "choice", allowOther: true, secret: false,
        options: [{ label: "Engineering", description: "Builds it", value: "eng" }, { label: "Operations", value: "ops" }] },
      { question: "Which labels?", header: "Labels", multiSelect: true, id: "labels", kind: "multi", allowOther: false, secret: false,
        options: [{ label: "bug" }, { label: "p1" }] },
      { question: "Paste the deploy token", header: "", multiSelect: false, id: "token", kind: "text", allowOther: false, secret: true, required: true, placeholder: "tok_…", options: [] },
      // A yes-or-no carries no options on its card; the phone is given the two the desktop draws.
      { question: "Ship it now?", header: "", multiSelect: false, id: "ship", kind: "confirm", allowOther: false, secret: false, default: "no",
        options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] },
    ]);
  });

  it("reads an AskUserQuestion that predates the card off its input, and leaves a request Realm declined as no question", () => {
    const p = new SessionProjector();
    const input = { questions: [{ question: "Which regions?", header: "Regions", multiSelect: true, options: [{ label: "us-east" }, { label: "eu-west" }] }] };
    p.apply(persisted(sessionEvent("permission_request", { requestId: "old", toolName: "AskUserQuestion", input, title: "Question", suggestions: [] })));
    const refused = { asker: { kind: "server" as const, name: "Shady" }, mode: "form" as const, refused: "It asked for a password.", questions: [{ id: "_", prompt: "Password?", kind: "text" as const }] };
    p.apply(persisted(sessionEvent("permission_request", { requestId: "no", toolName: "mcp__shady__ask", input: {}, title: "Shady asks", suggestions: [], ask: refused })));
    const [old, declined] = p.all();
    expect(old).toMatchObject({ asker: "Claude", questions: [{ id: "Which regions?", question: "Which regions?", multiSelect: true, allowOther: true, options: [{ label: "us-east" }, { label: "eu-west" }] }] });
    expect(declined).toMatchObject({ kind: "request", questions: null });
  });

  it("keeps the answers a request was given, a secret one only as its mark", () => {
    const p = new SessionProjector();
    const input = { questions: [{ question: "Which?", header: "", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] };
    p.apply(persisted(sessionEvent("permission_request", { requestId: "r1", toolName: "AskUserQuestion", input, title: "Question", suggestions: [] })));
    p.apply(persisted(sessionEvent("permission_response", { requestId: "r1", decision: "allow", answers: { "Which?": ["A", "mine"], token: "••••••" } })));
    expect(p.all()[0]).toMatchObject({ state: "allowed", answers: { "Which?": ["A", "mine"], token: "••••••" } });
  });

  it("puts the plan's text and steps on the request that asks to approve it", () => {
    const p = new SessionProjector();
    p.apply(persisted(sessionEvent("plan", { planId: "p1", steps: [{ text: "Write the migration", status: "pending" }, { text: "Test it", status: "pending" }] })));
    p.apply(persisted(sessionEvent("permission_request", { requestId: "x1", toolName: "ExitPlanMode", input: { plan: "## Plan\n\nAdd a column." }, title: "Approve the plan?", suggestions: [] })));
    const request = p.all().find((r) => r.kind === "request");
    // THE MUTANT: carry no plan, and the phone approves something it was never shown.
    expect(request).toMatchObject({ kind: "request", questions: null, plan: { text: "## Plan\n\nAdd a column.", steps: [{ text: "Write the migration", status: "pending" }, { text: "Test it", status: "pending" }] } });
    expect(RowSchema.safeParse(request).success).toBe(true);
    // A plan with no prose of its own takes the latest plan's.
    const q = new SessionProjector();
    q.apply(persisted(sessionEvent("plan", { planId: "p2", text: "Do the thing" })));
    q.apply(persisted(sessionEvent("permission_request", { requestId: "x2", toolName: "ExitPlanMode", input: {}, title: "Approve the plan?", suggestions: [] })));
    expect(q.all().find((r) => r.kind === "request")).toMatchObject({ plan: { text: "Do the thing", steps: null } });
  });

  it("holds the suggested next message until something is sent, and never lets an older one replace a newer", () => {
    const p = new SessionProjector();
    expect(p.hint).toBeNull();
    p.apply(persisted(sessionEvent("prompt_hint", { text: "Run the tests", throughSeq: 5 })));
    expect(p.hint).toBe("Run the tests");
    p.apply(persisted(sessionEvent("prompt_hint", { text: "Ship it", throughSeq: 9 })));
    p.apply(persisted(sessionEvent("prompt_hint", { text: "An older thought", throughSeq: 7 })));
    // THE MUTANT: last-arrived wins, and a slow hint for an earlier turn replaces the current one.
    expect(p.hint).toBe("Ship it");
    p.apply(persisted(sessionEvent("user_message", { text: "ship it", attachments: [] })));
    expect(p.hint).toBeNull();
  });

  it("draws a move as one row that follows its steps and becomes the notice of how it ended", () => {
    const p = new SessionProjector();
    const place = { machine: null, environmentId: "01J00000000000000000000000", cwd: "/r", branch: null };
    p.apply(persisted(sessionEvent("moving", { moveId: "m", step: "preflight" })));
    p.apply(persisted(sessionEvent("moving", { moveId: "m", step: "place" })));
    expect(p.all()).toEqual([expect.objectContaining({ key: "mv:m", kind: "notice", move: "moving", text: "Moving · Setting up the checkout" })]);
    p.apply(persisted(sessionEvent("moved", { moveId: "m", from: place, to: { ...place, cwd: "/w" }, conversation: "native", changedFiles: 0, leftBehind: [], preface: "p", note: "Moved from r to w. The conversation continued." })));
    p.apply(persisted(sessionEvent("moving", { moveId: "n", step: "boot" })));
    p.apply(persisted(sessionEvent("move_failed", { moveId: "n", step: "boot", reason: "x", note: "Couldn't move this session while starting the agent." })));
    expect(p.all()).toMatchObject([{ key: "mv:m", text: "Moved from r to w. The conversation continued." }, { key: "mv:n", text: "Couldn't move this session while starting the agent." }]);
    for (const r of p.all()) expect(RowSchema.safeParse(r).success).toBe(true);
  });

  it("marks a move's rows for the phone, with both paths under the moved line", () => {
    const p = new SessionProjector({ attachmentsDir: null, home: "/Users/me" });
    const place = { machine: null, environmentId: "01J00000000000000000000000", cwd: "/Users/me/realm", branch: "main" };
    const to = { ...place, cwd: "/Users/me/Realm/worktrees/x/fix-tests", branch: "realm/fix-tests" };
    p.apply(persisted(sessionEvent("assistant_text", { messageId: "a", text: "Done." })));
    expect(p.apply(persisted(sessionEvent("moving", { moveId: "m", step: "freeze" })))).toMatchObject([{ key: "mv:m", kind: "notice", move: "moving", text: "Moving · Pausing the agent" }]);
    p.apply(persisted(sessionEvent("moved", { moveId: "m", from: place, to, conversation: "native", changedFiles: 2, leftBehind: [], preface: "p", note: movedSentence({ from: place, to, conversation: "native" }) })));
    expect(p.all().map((r) => r.key)).toEqual(["m:a", "mv:m"]);
    expect(p.all()[1]).toMatchObject({
      kind: "notice", move: "moved", text: "Moved from realm (main) to fix-tests. The conversation continued.",
      detail: "~/realm → ~/Realm/worktrees/x/fix-tests",
    });
    p.apply(persisted(sessionEvent("move_failed", { moveId: "n", step: "boot", reason: "x", from: place, note: moveFailedSentence({ step: "boot", from: place }) })));
    expect(p.all()[2]).toMatchObject({ key: "mv:n", move: "failed", text: "Couldn't move this session while starting the agent. It's still in realm (main).", detail: "x" });
    for (const r of p.all()) expect(RowSchema.safeParse(r).success).toBe(true);
  });

  it("shows a failed move's sentence, and keeps what the note says after it with git's words for the tap", () => {
    const p = new SessionProjector({ attachmentsDir: null, home: "/Users/me" });
    const from = { machine: null, environmentId: "01J00000000000000000000000", cwd: "/Users/me/realm", branch: "main" };
    const reason = "Command failed: git -c core.fsmonitor= worktree add -b realm/x /var/folders/tmp/x HEAD\nPreparing worktree (new branch 'realm/x')";
    const left = "The changes it merged into ~/Realm/worktrees/x were left as they were.";
    const sentence = moveFailedSentence({ step: "place", from });
    p.apply(persisted(sessionEvent("move_failed", { moveId: "n", step: "place", reason, from, note: `${sentence} ${left}` })));
    // THE MUTANT: the whole note as the line, and the rollback reads as part of the sentence older phones show.
    expect(p.all()[0]).toMatchObject({ move: "failed", text: "Couldn't move this session while setting up the checkout. It's still in realm (main).", detail: `${reason}\n${left}` });
    // A failure whose checkout was gone names no place.
    p.apply(persisted(sessionEvent("move_failed", { moveId: "o", step: "freeze", reason: "the agent would not stop", note: moveFailedSentence({ step: "freeze" }) })));
    expect(p.all()[1]).toMatchObject({ text: "Couldn't move this session while pausing the agent.", detail: "the agent would not stop" });
    for (const r of p.all()) expect(RowSchema.safeParse(r).success).toBe(true);
  });

  it("names a turn's checkpoint on its changes, and the files a turn made by their paths", () => {
    const p = new SessionProjector();
    p.apply(persisted(sessionEvent("turn_changes", { checkpointId: "cp1", settledAt: 1, root: "/r", afterTree: "abc", files: [{ path: "a.ts", oldPath: null, status: "modified", additions: 1, deletions: 1 }], totalFiles: 1 })));
    p.apply(persisted(sessionEvent("files_made", { settledAt: 7, files: [{ path: "/Users/me/shot.png", size: 1024 }], totalFiles: 1 })));
    expect(p.all()).toMatchObject([{ kind: "notice", checkpointId: "cp1" }, { kind: "notice", files: [{ path: "/Users/me/shot.png", size: 1024 }] }]);
    for (const r of p.all()) expect(RowSchema.safeParse(r).success).toBe(true);
  });

  it("names the files sent with a message by their paths on the Mac, and a message with none carries no list", () => {
    const p = new SessionProjector();
    const sent = [{ path: "/Users/me/Realm/tmp/attachments/3f9a1c2b4d5e-IMG_0042.jpg", mime: "image/jpeg" }, { path: "/Users/me/notes.md", mime: "text/markdown" }];
    p.apply(persisted(sessionEvent("user_message", { text: "", attachments: sent })));
    p.apply(persisted(sessionEvent("user_message", { text: "and this", attachments: [] })));
    const [withFiles, without] = p.all();
    // THE MUTANT: the row keeps only its text, and the phone shows a message sent with a photo as an
    // empty bubble.
    expect(withFiles).toMatchObject({ kind: "user", text: "", attachments: [
      { path: sent[0]!.path, name: "3f9a1c2b4d5e-IMG_0042.jpg", mime: "image/jpeg" }, { path: "/Users/me/notes.md", name: "notes.md", mime: "text/markdown" },
    ] });
    expect(without).not.toHaveProperty("attachments");
    for (const r of p.all()) expect(RowSchema.safeParse(r).success).toBe(true);
  });

  it("names a file sent from the attachments folder as it was given, and any other file by its own name", () => {
    const dir = "/Users/me/Realm/tmp/attachments";
    const p = new SessionProjector({ attachmentsDir: dir });
    const sent = [
      `${dir}/3f9a1c2b4d5e-IMG_0042.jpg`, "/Users/me/report-v2.pdf", "/Users/me/Downloads/0123456789ab-notes.md",
      `${dir}/report-v2.pdf`, `${dir}/older/0123456789ab-chart.png`, `${dir}/3f9a1c2b4d5-short.png`,
    ];
    p.apply(persisted(sessionEvent("user_message", { text: "", attachments: sent.map((path) => ({ path, mime: "application/octet-stream" })) })));
    const [row] = p.all();
    // THE MUTANTS: strip nothing, and a photo reads "3f9a1c2b4d5e-IMG_0042.jpg"; or strip wherever the
    // name looks prefixed, and a file the person named so loses part of its name.
    expect(row?.kind === "user" && row.attachments?.map((a) => a.name)).toEqual([
      "IMG_0042.jpg", "report-v2.pdf", "0123456789ab-notes.md", "report-v2.pdf", "0123456789ab-chart.png", "3f9a1c2b4d5-short.png",
    ]);
    // The path is the file's own, whatever it is called.
    expect(row?.kind === "user" && row.attachments?.map((a) => a.path)).toEqual(sent);
  });

  it("draws a message to a teammate as that teammate, by the server's own reading of `to`, without the prefix its words were sent with", () => {
    const p = new SessionProjector();
    p.knowTeam([{ id: "id-cto", handle: "cto", lead: true }, { id: "id-designer", handle: "designer", lead: false }]);
    p.apply(persisted(sessionEvent("tool_call", { toolUseId: "t1", name: "mcp__realm__realm-team__team_message", input: { to: "@Designer", message: "From @cto: From @cto: Ship the icons" }, parentToolUseId: null })));
    p.apply(persisted(sessionEvent("tool_call", { toolUseId: "t2", name: "team_message", input: { to: "lead", message: "Done" }, parentToolUseId: null })));
    p.apply(persisted(sessionEvent("tool_call", { toolUseId: "t3", name: "team_message", input: { to: "intern", message: "Hi" }, parentToolUseId: null })));
    p.apply(persisted(sessionEvent("tool_call", { toolUseId: "t4", name: "team_list", input: {}, parentToolUseId: null })));
    // THE MUTANTS: `@Designer` read as written, `lead` left unresolved, the prefix kept, or another tool given a teammate.
    expect(p.all().map((r) => (r.kind === "tool" ? r.teammate ?? null : r.kind))).toEqual([
      { id: "id-designer", handle: "designer", message: "Ship the icons" },
      { id: "id-cto", handle: "cto", message: "Done" },
      { id: null, handle: "intern", message: "Hi" },
      null,
    ]);
    p.apply(persisted(sessionEvent("tool_result", { toolUseId: "t1", content: "Sent to @designer", isError: false })));
    p.apply(persisted(sessionEvent("tool_result", { toolUseId: "t3", content: "No teammate @intern", isError: true })));
    // A refused one is the tool call it was, with its error; an answered one is still the teammate.
    expect(p.all()[0]).toMatchObject({ state: "done", teammate: { id: "id-designer" } });
    expect(p.all()[2]).toMatchObject({ state: "error", detail: "No teammate @intern" });
    expect(p.all()[2]).not.toHaveProperty("teammate");
    for (const row of p.all()) expect(RowSchema.safeParse(row).success).toBe(true);
  });

  it("draws another teammate's message in a chat as that teammate's words, and the person's own as theirs", () => {
    const p = new SessionProjector();
    p.apply(persisted(sessionEvent("user_message", { text: "From @cto: Look at the plan", attachments: [], from: { sessionId: "cto-chat", title: "CTO", teammateId: "id-cto" } })));
    p.apply(persisted(sessionEvent("user_message", { text: "From @cto: is how it starts", attachments: [] })));
    // THE MUTANTS: the sender dropped, or the person's own words that happen to start so cut short.
    expect(p.all()).toMatchObject([{ kind: "user", text: "Look at the plan", teammateId: "id-cto" }, { kind: "user", text: "From @cto: is how it starts" }]);
    expect(p.all()[1]).not.toHaveProperty("teammateId");
  });

  it("names a tool call by what it touches", () => {
    expect(summarize("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    // A long path loses its folders, never its file's name, which is what the phone's line shows.
    const deep = `/private/tmp/${"nested/".repeat(20)}tasks/b0by9i0ez.output`;
    expect(summarize("Read", { file_path: deep })).toMatch(/^….*\/tasks\/b0by9i0ez\.output$/);
    expect(summarize("Read", { file_path: deep })).toHaveLength(120);
    expect(summarize("Bash", { command: `echo ${"x".repeat(200)}` })).toMatch(/^echo x+…$/);
    expect(summarize("WebSearch", { query: "noise protocol" })).toBe("noise protocol");
    expect(summarize("mcp__x__y", { url: "https://x" })).toBe("https://x");
    expect(summarize("Mystery", {})).toBe("Mystery");
  });
});

describe("a goal's turns and the agent's to-do list on the phone", () => {
  const prompt = goalContinuationPrompt({ objective: "ship the notes", turns: 1, tokensUsed: 900, tokenBudget: null }, "mcp__realm__realm-goal__update_goal");

  it("draws a goal's own turn as the desktop's attributed line with the prompt under it, never as the person's bubble", () => {
    const p = new SessionProjector();
    p.apply(persisted(sessionEvent("user_message", { text: "ship the notes", attachments: [] })));
    p.apply(persisted(sessionEvent("user_message", { text: prompt, attachments: [], goal: "continuation" })));
    p.apply(persisted(sessionEvent("user_message", { text: "Say what is done.", attachments: [], goal: "budget" })));
    const [objective, continued, handover] = p.all();
    // The objective is the person's own words, and stays their bubble.
    expect(objective).toMatchObject({ kind: "user", text: "ship the notes" });
    expect(continued).toEqual({ key: continued!.key, seq: continued!.seq, kind: "notice", text: goalTurnLabel("continuation"), detail: prompt, goal: "continuation" });
    expect(handover).toMatchObject({ kind: "notice", text: "Goal budget spent — Realm asked for a handover", goal: "budget" });
    expect(p.all().some((r) => r.kind === "user" && r.text.includes("update_goal"))).toBe(false);
    for (const row of p.all()) expect(RowSchema.safeParse(row).success).toBe(true);
  });

  it("keeps the newest TodoWrite as the list, in the agent's order, and never a sub-agent's", () => {
    const p = new SessionProjector();
    const todo = (content: string, status: string, activeForm?: string) => ({ content, status, ...(activeForm ? { activeForm } : {}) });
    const write = (toolUseId: string, todos: unknown[], parentToolUseId: string | null = null) =>
      p.apply(persisted(sessionEvent("tool_call", { toolUseId, name: "TodoWrite", input: { todos }, parentToolUseId })));
    expect(p.todos).toEqual([]);
    write("t1", [todo("Write it", "in_progress", "Writing it"), todo("Test it", "pending")]);
    write("t2", [todo("Write it", "completed", "Writing it"), todo("Test it", "in_progress", "Testing it"), todo("Ship it", "pending")]);
    write("t3", [todo("A helper's own step", "in_progress")], "t-task");
    expect(p.todos).toEqual([
      { content: "Write it", status: "completed", activeForm: "Writing it" },
      { content: "Test it", status: "in_progress", activeForm: "Testing it" },
      { content: "Ship it", status: "pending", activeForm: null },
    ]);
    // An empty or unreadable list drops the plan, rather than putting an older one back.
    write("t4", [todo("Bad", "someday")]);
    expect(p.todos).toEqual([]);
  });
});
