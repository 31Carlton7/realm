import { describe, expect, it } from "vitest";
import {
  AskCardSchema, HIDDEN_ANSWER, UiAskInputSchema, askCardFromAskUserQuestion, askCardFromElicitation, asksForCredential,
  claudeAnswers, elicitationContent, isWorkspaceRelative, loggableAnswers, normalizeAnswers, requiredAnswered, type AskCard,
} from "./ui-ask";

const claude = { kind: "agent" as const, name: "Claude", agent: "claude" as const };
const linear = { kind: "server" as const, name: "Linear" };

describe("askCardFromAskUserQuestion — only a genuinely question-shaped payload becomes a card", () => {
  it("keys each question by its text, the way the SDK reads answers back", () => {
    const card = askCardFromAskUserQuestion({ questions: [{ question: "Pick?", header: "H", multiSelect: false, options: [{ label: "A", description: "d" }, { label: "B" }] }] }, claude)!;
    expect(card.mode).toBe("question");
    expect(card.asker).toEqual(claude);
    expect(card.questions).toEqual([{ id: "Pick?", prompt: "Pick?", header: "H", kind: "choice", allowOther: true,
      options: [{ value: "A", label: "A", description: "d" }, { value: "B", label: "B" }] }]);
  });

  it("reads multiSelect as several, no options as a text question, and carries secret", () => {
    const card = askCardFromAskUserQuestion({ questions: [
      { question: "Which?", options: [{ label: "A" }], multiSelect: true, allowOther: false },
      { question: "Token?", options: [], secret: true },
    ] }, claude)!;
    expect(card.questions.map((q) => [q.kind, q.allowOther, q.secret])).toEqual([["multi", false, undefined], ["text", undefined, true]]);
  });

  it.each([
    ["no questions key", {}],
    ["empty questions", { questions: [] }],
    ["question missing text", { questions: [{ header: "H", options: [{ label: "A" }] }] }],
    ["neither options nor free text", { questions: [{ question: "Pick?", options: [], allowOther: false }] }],
    ["option missing a label", { questions: [{ question: "Pick?", options: [{ description: "d" }] }] }],
  ])("is null on malformed input: %s", (_name, input) => {
    expect(askCardFromAskUserQuestion(input, claude)).toBeNull();
  });

  it("hands several back to the SDK comma-joined, as its own contract says", () => {
    expect(claudeAnswers({ "Which?": ["A", "B"], "Name?": "Ada" })).toEqual({ "Which?": "A, B", "Name?": "Ada" });
  });
});

describe("askCardFromElicitation — an MCP form becomes the card, and a credential form never does", () => {
  const form = (properties: Record<string, unknown>, required: string[] = [], message = "Create the issue") =>
    askCardFromElicitation({ mode: "form", message, requestedSchema: { type: "object", properties, required } }, linear);

  it("draws every primitive MCP's subset has", () => {
    const card = form({
      team: { type: "string", title: "Team", oneOf: [{ const: "eng", title: "Engineering" }, { const: "des", title: "Design" }] },
      labels: { type: "array", title: "Labels", items: { type: "string", enum: ["bug", "ui"] }, default: ["bug"] },
      estimate: { type: "integer", title: "Estimate", minimum: 1, maximum: 8 },
      urgent: { type: "boolean", title: "Urgent?", default: false },
      due: { type: "string", title: "Due", format: "date" },
      contact: { type: "string", title: "Contact", format: "email", description: "who to tell" },
    }, ["team"]);
    expect(card.refused).toBeUndefined();
    expect(card.mode).toBe("form");
    expect(card.message).toBe("Create the issue");
    const byId = Object.fromEntries(card.questions.map((q) => [q.id, q]));
    expect(byId.team).toMatchObject({ kind: "choice", required: true, options: [{ value: "eng", label: "Engineering" }, { value: "des", label: "Design" }] });
    expect(byId.labels).toMatchObject({ kind: "multi", default: ["bug"] });
    expect(byId.estimate).toMatchObject({ kind: "text", format: "integer", min: 1, max: 8 });
    expect(byId.urgent).toMatchObject({ kind: "confirm", default: "no" });
    expect(byId.due).toMatchObject({ kind: "time", format: "date" });
    expect(byId.contact).toMatchObject({ kind: "text", format: "email", detail: "who to tell" });
  });

  it("asks a one-field form as one question: the message is the prompt", () => {
    const card = form({ name: { type: "string", title: "Username" } }, ["name"], "Please provide your GitHub username");
    expect(card.message).toBeUndefined();
    expect(card.questions).toEqual([expect.objectContaining({ id: "name", prompt: "Please provide your GitHub username", header: "Username", kind: "text" })]);
  });

  it.each([
    ["password", { password: { type: "string" } }],
    ["an API key by title", { k: { type: "string", title: "API key" } }],
    ["a camelCase token", { githubToken: { type: "string" } }],
    ["a card number", { card_number: { type: "string" } }],
    ["a write-only field", { thing: { type: "string", writeOnly: true } }],
  ])("declines a form that asks for a credential: %s", (_name, properties) => {
    // THE MUTANT: drop the credential check. The form draws as an ordinary, UNMASKED field, and what
    // the user types into it goes into the log with every other form answer.
    const card = form(properties);
    expect(card.refused).toMatch(/password or a key/);
  });

  it("does not mistake a count of tokens, or a yes/no about a secret, for a credential", () => {
    expect(asksForCredential("max_tokens", { type: "integer", title: "Max tokens" })).toBe(false);
    expect(asksForCredential("keepSecret", { type: "boolean", title: "Keep it secret?" })).toBe(false);
  });

  it("declines what it cannot draw rather than drawing half of it", () => {
    expect(form({ nested: { type: "object", properties: {} } }).refused).toMatch(/cannot draw/);
    expect(form({}).refused).toMatch(/nothing to fill in/);
    const many = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${i}`, { type: "string" }]));
    expect(form(many).refused).toMatch(/13 fields/);
  });

  it("makes a URL request a page to open, and refuses one that is not a web address", () => {
    const card = askCardFromElicitation({ mode: "url", message: "Authorize access", url: "https://auth.linear.app/connect?x=1" }, linear);
    expect(card).toMatchObject({ mode: "url", questions: [{ kind: "link", url: "https://auth.linear.app/connect?x=1", prompt: "Authorize access" }] });
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "not a url"]) {
      expect(askCardFromElicitation({ mode: "url", message: "x", url }, linear).refused).toBeDefined();
    }
  });

  it("answers in the form's own types", () => {
    const card = form({
      labels: { type: "array", items: { type: "string", enum: ["bug", "ui"] } },
      estimate: { type: "integer" }, ratio: { type: "number" }, urgent: { type: "boolean" },
      at: { type: "string", format: "date-time" }, title: { type: "string" },
    });
    const content = elicitationContent(card, { labels: ["ui"], estimate: "3", ratio: "0.5", urgent: "yes", at: "2026-10-05T14:30", title: "Fix it" });
    expect(content).toMatchObject({ labels: ["ui"], estimate: 3, ratio: 0.5, urgent: true, title: "Fix it" });
    expect(content.at).toBe(new Date(Date.parse("2026-10-05T14:30")).toISOString());
    // An integer field is not answered by a fraction.
    expect(elicitationContent(card, { estimate: "2.5" }).estimate).toBeUndefined();
  });

  it("says whether every required field has an answer", () => {
    const card = form({ a: { type: "string" }, b: { type: "string" } }, ["a"]);
    expect(requiredAnswered(card, { b: "x" })).toBe(false);
    expect(requiredAnswered(card, { a: "x" })).toBe(true);
  });
});

describe("answers are held to the card they were asked with", () => {
  const card: AskCard = AskCardSchema.parse({
    asker: claude, mode: "question", workspace: "/repo",
    questions: [
      { id: "db", prompt: "Which?", kind: "choice", options: [{ value: "pg", label: "Postgres" }] },
      { id: "free", prompt: "Which?", kind: "choice", options: [{ value: "a", label: "A" }], allowOther: true },
      { id: "who", prompt: "Who builds each step?", kind: "model", rows: [{ id: "1", label: "One" }, { id: "2", label: "Two" }],
        options: [{ value: "claude-opus-5-5", label: "Claude Opus 5.5", agent: "claude" }, { value: "gpt-6-luna", label: "GPT-6 Luna", agent: "codex" }] },
      { id: "file", prompt: "Which file?", kind: "file", multiple: true },
      { id: "day", prompt: "When?", kind: "time", format: "date" },
      { id: "key", prompt: "Key?", kind: "text", secret: true },
    ],
  });

  it("keeps an offered choice and refuses one it never offered", () => {
    expect(normalizeAnswers(card, { db: "pg", free: "anything", ghost: "x" })).toEqual({ db: "pg", free: "anything" });
    expect(normalizeAnswers(card, { db: "mysql" })).toEqual({});
  });

  it("takes one offered model per row, in row order, or nothing", () => {
    expect(normalizeAnswers(card, { who: ["gpt-6-luna", "claude-opus-5-5"] }).who).toEqual(["gpt-6-luna", "claude-opus-5-5"]);
    expect(normalizeAnswers(card, { who: ["gpt-6-luna"] }).who).toBeUndefined();
    expect(normalizeAnswers(card, { who: ["gpt-6-luna", "made-up"] }).who).toBeUndefined();
  });

  it("keeps a file inside the workspace and nothing that climbs out of it", () => {
    expect(normalizeAnswers(card, { file: ["src/a.ts", "../etc/passwd", "/etc/passwd", "~/x"] }).file).toEqual(["src/a.ts"]);
    expect(isWorkspaceRelative("a/../../b")).toBe(false);
  });

  it("keeps a date in the field's format", () => {
    expect(normalizeAnswers(card, { day: "2026-10-05" }).day).toBe("2026-10-05");
    expect(normalizeAnswers(card, { day: "tomorrow" }).day).toBeUndefined();
  });

  it("logs a masked answer as a mark and every other answer as given", () => {
    // THE MUTANT: return the answers unmasked. The persisted, broadcast permission_response would
    // then carry the secret to every window and into the database.
    expect(loggableAnswers(card, { key: "sk-live-1234", db: "pg" })).toEqual({ key: HIDDEN_ANSWER, db: "pg" });
  });
});

describe("UiAskInputSchema — what an agent may ask", () => {
  const q = (over: Record<string, unknown> = {}) => ({ id: "q", prompt: "Pick one", kind: "choice", options: [{ label: "A" }, { label: "B" }], ...over });

  it("takes one to four questions", () => {
    expect(UiAskInputSchema.safeParse({ questions: [q()] }).success).toBe(true);
    expect(UiAskInputSchema.safeParse({ questions: [] }).success).toBe(false);
    expect(UiAskInputSchema.safeParse({ questions: [1, 2, 3, 4, 5].map((n) => q({ id: `q${n}` })) }).success).toBe(false);
  });

  it("refuses a choice with neither options nor a field of the user's own", () => {
    expect(UiAskInputSchema.safeParse({ questions: [q({ options: [] })] }).success).toBe(false);
    expect(UiAskInputSchema.safeParse({ questions: [q({ options: [], allowOther: true })] }).success).toBe(true);
  });

  it("refuses options on a field Realm fills, a secret that is not text, and two questions with one id", () => {
    expect(UiAskInputSchema.safeParse({ questions: [q({ kind: "model" })] }).success).toBe(false);
    expect(UiAskInputSchema.safeParse({ questions: [q({ secret: true })] }).success).toBe(false);
    expect(UiAskInputSchema.safeParse({ questions: [q(), q()] }).success).toBe(false);
  });

  it("refuses fields it does not name, so an agent cannot smuggle in a URL or markup", () => {
    expect(UiAskInputSchema.safeParse({ questions: [q({ url: "https://evil.example" })] }).success).toBe(false);
    expect(UiAskInputSchema.safeParse({ questions: [q({ options: [{ label: "A", html: "<b>" }] })] }).success).toBe(false);
  });
});
