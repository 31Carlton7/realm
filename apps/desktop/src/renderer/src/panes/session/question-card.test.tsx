import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AskCardSchema, HIDDEN_ANSWER, sessionEvent, type AskCard, type AskQuestion } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi } from "../../state/store.test-fakes";
import { AnsweredQuestion, QuestionCard, askCardFor, askerLine } from "./QuestionCard";
import { Transcript } from "./Transcript";
import { reduceAll } from "./transcript-model";

afterEach(() => cleanup());

const codex = { kind: "agent" as const, name: "Codex", agent: "codex" as const };
const cardOf = (questions: Partial<AskQuestion>[], over: Partial<AskCard> = {}): AskCard => AskCardSchema.parse({
  asker: codex, mode: "question",
  questions: questions.map((q, i) => ({ id: `q${i}`, prompt: `Question ${i}?`, kind: "choice", ...q })),
  ...over,
});
const db = (over: Partial<AskQuestion> = {}): Partial<AskQuestion> => ({
  id: "db", prompt: "Which database?", header: "Database", kind: "choice", allowOther: true,
  options: [{ value: "pg", label: "Postgres", description: "Relational, boring, correct" }, { value: "sqlite", label: "SQLite", description: "Local, zero-ops" }],
  ...over,
});

const mount = (card: AskCard, props: { onAnswer?: () => void; onSkip?: () => void; ownsEscape?: boolean } = {}) => {
  const onAnswer = props.onAnswer ?? vi.fn();
  const onSkip = props.onSkip ?? vi.fn();
  const r = render(<QuestionCard card={card} onAnswer={onAnswer} onSkip={onSkip} ownsEscape={props.ownsEscape} />);
  const el = r.container.querySelector<HTMLElement>(".question-card")!;
  return { el, onAnswer, onSkip };
};
const rowsOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".question-option, .question-tile")];

describe("askCardFor — a question is told apart by Realm's card, never by the agent's arguments", () => {
  it("draws a request carrying a card as that card", () => {
    const ask = cardOf([db()]);
    expect(askCardFor({ toolName: "item/tool/requestUserInput", input: {}, ask })).toEqual(ask);
  });

  it("reads Claude's AskUserQuestion from before cards rode the event, and names Claude", () => {
    const card = askCardFor({ toolName: "AskUserQuestion", input: { questions: [{ question: "Pick?", options: [{ label: "A" }] }] } })!;
    expect(card.asker.name).toBe("Claude");
    expect(card.questions[0]).toMatchObject({ id: "Pick?", kind: "choice" });
  });

  it("refuses any other tool, so a Bash call can never draw as a question", () => {
    expect(askCardFor({ toolName: "Bash", input: { questions: [{ question: "Pick?", options: [{ label: "A" }] }] } })).toBeNull();
  });

  it("falls back on a card that would leave no row to answer on, or one Realm already declined", () => {
    expect(askCardFor({ toolName: "ui_ask", input: {}, ask: { asker: codex, mode: "question", questions: [{ id: "a", prompt: "?", kind: "choice", options: [] }] } as never })).toBeNull();
    expect(askCardFor({ toolName: "elicitation", input: {}, ask: cardOf([db()], { refused: "It asked for a password." }) })).toBeNull();
  });
});

describe("the card names who is asking", () => {
  it.each([
    [{ kind: "agent", name: "Codex" }, "Codex asks"],
    [{ kind: "server", name: "Linear" }, "Linear's MCP server asks"],
    [{ kind: "server", name: "notion", via: "Codex" }, "notion's MCP server asks, through Codex"],
  ] as const)("%o reads %s", (asker, line) => {
    expect(askerLine(asker)).toBe(line);
    const { el } = mount(cardOf([db()], { asker }));
    expect(el.querySelector(".question-from")).toHaveTextContent(line);
  });

  it("draws every label as plain text — markup an agent sends is never rendered", () => {
    const { el } = mount(cardOf([db({ prompt: "<img src=x onerror=alert(1)>", options: [{ value: "a", label: "<b>bold</b>" }] })]));
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("b")).toBeNull();
    expect(within(el).getByRole("heading")).toHaveTextContent("<img src=x onerror=alert(1)>");
  });

  it("carries data-no-agent, so an agent driving the window cannot answer for the user", () => {
    const { el } = mount(cardOf([db()]));
    expect(el).toHaveAttribute("data-no-agent", "question");
  });
});

describe("a choice", () => {
  it("shows the question and its options as labelled rows, with the free-text row last", () => {
    const { el } = mount(cardOf([db()]));
    expect(within(el).getByRole("heading")).toHaveTextContent("Which database?");
    expect(rowsOf(el).map((r) => r.getAttribute("aria-label"))).toEqual(["Postgres", "SQLite", "Something else"]);
    expect(el).toHaveTextContent("Relational, boring, correct");
    expect(el.querySelector(".question-tag")).toHaveTextContent("Database");
  });

  it("answers with the option's value, keyed by the question's id", () => {
    const { el, onAnswer } = mount(cardOf([db()]));
    fireEvent.click(rowsOf(el)[1]!);
    expect(onAnswer).toHaveBeenCalledWith({ db: "sqlite" });
  });

  it("a number key picks that option outright, and an arrow moves the highlight", () => {
    const { el, onAnswer } = mount(cardOf([db()]));
    const selected = () => el.querySelector(".question-option[data-selected]")!.getAttribute("aria-label");
    fireEvent.keyDown(rowsOf(el)[0]!, { key: "ArrowDown" });
    expect(selected()).toBe("SQLite");
    fireEvent.keyDown(rowsOf(el)[0]!, { key: "1" });
    expect(onAnswer).toHaveBeenCalledWith({ db: "pg" });
  });

  it("'Something else' takes free text, and Esc inside it backs out instead of skipping", () => {
    const { el, onAnswer, onSkip } = mount(cardOf([db()]));
    fireEvent.click(within(el).getByRole("button", { name: "Something else" }));
    const input = within(el).getByRole("textbox", { name: "Your answer" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onSkip).not.toHaveBeenCalled();
    fireEvent.click(within(el).getByRole("button", { name: "Something else" }));
    fireEvent.change(within(el).getByRole("textbox", { name: "Your answer" }), { target: { value: "DuckDB" } });
    fireEvent.click(within(el).getByRole("button", { name: "Answer" }));
    expect(onAnswer).toHaveBeenCalledWith({ db: "DuckDB" });
  });

  it("several picks toggle, and Continue sends them as a list", () => {
    const { el, onAnswer } = mount(cardOf([db({ kind: "multi", allowOther: false })]));
    const cont = within(el).getByRole("button", { name: /Continue/ });
    expect(cont).toBeDisabled();
    fireEvent.click(rowsOf(el)[0]!); fireEvent.click(rowsOf(el)[1]!); fireEvent.click(rowsOf(el)[0]!);
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.click(cont);
    expect(onAnswer).toHaveBeenCalledWith({ db: ["sqlite"] });
  });

  it("draws options with pictures as tiles, each with its picture's well", () => {
    const { el, onAnswer } = mount(cardOf([{ id: "look", prompt: "Which look?", kind: "choice",
      options: [{ value: "Calm", label: "Calm", image: "/repo/mockups/calm.png" }, { value: "Bold", label: "Bold", image: "/repo/mockups/bold.png" }] }]));
    const tiles = [...el.querySelectorAll(".question-tile")];
    expect(tiles).toHaveLength(2);
    // No bridge in the suite, so the well shows the image glyph — never a URL the agent wrote.
    expect(tiles[0]!.querySelector(".question-tile-pic")).not.toBeNull();
    fireEvent.click(tiles[1]!);
    expect(onAnswer).toHaveBeenCalledWith({ look: "Bold" });
  });

  it("asks a yes-or-no as two rows that answer yes or no", () => {
    const { el, onAnswer } = mount(cardOf([{ id: "go", prompt: "Ship it?", kind: "confirm" }]));
    expect(rowsOf(el).map((r) => r.getAttribute("aria-label"))).toEqual(["Yes", "No"]);
    fireEvent.click(rowsOf(el)[1]!);
    expect(onAnswer).toHaveBeenCalledWith({ go: "no" });
  });

  it("filters a long list of branches and marks the current one", () => {
    const branches = Array.from({ length: 10 }, (_, i) => ({ value: `feat/${i}`, label: `feat/${i}`, ...(i === 3 ? { current: true } : {}) }));
    const { el } = mount(cardOf([{ id: "base", prompt: "Which branch?", kind: "branch", options: branches, default: "feat/3" }]));
    expect(el.querySelector(".question-option[data-selected]")).toHaveAttribute("aria-label", "feat/3");
    expect(el.querySelector(".question-option[data-selected]")).toHaveTextContent("Current");
    fireEvent.change(within(el).getByRole("textbox", { name: "Filter the options" }), { target: { value: "/7" } });
    expect(rowsOf(el).map((r) => r.getAttribute("aria-label"))).toEqual(["feat/7"]);
  });
});

describe("paging, skipping and Escape", () => {
  const two = () => cardOf([db(), { id: "rt", prompt: "Which runtime?", kind: "choice", options: [{ value: "node", label: "Node" }, { value: "bun", label: "Bun" }] }]);

  it("answers several questions one at a time and hands every answer back together", () => {
    const { el, onAnswer } = mount(two());
    expect(el.querySelector(".question-pager")).toHaveTextContent("1 of 2");
    fireEvent.click(rowsOf(el)[0]!);
    expect(onAnswer).not.toHaveBeenCalled();
    expect(within(el).getByRole("heading")).toHaveTextContent("Which runtime?");
    fireEvent.click(rowsOf(el)[1]!);
    expect(onAnswer).toHaveBeenCalledWith({ db: "pg", rt: "bun" });
  });

  it("skipping the last of several still sends what was answered; skipping everything is a skip", () => {
    const first = mount(two());
    fireEvent.click(rowsOf(first.el)[0]!);
    fireEvent.click(first.el.querySelector<HTMLElement>(".question-skip")!);
    expect(first.onAnswer).toHaveBeenCalledWith({ db: "pg" });
    cleanup();
    const none = mount(cardOf([db()]));
    fireEvent.click(none.el.querySelector<HTMLElement>(".question-skip")!);
    expect(none.onSkip).toHaveBeenCalled();
    expect(none.onAnswer).not.toHaveBeenCalled();
  });

  it("offers no Skip on a question the asker requires", () => {
    const { el } = mount(cardOf([db({ required: true })]));
    expect(el.querySelector(".question-skip")).toBeNull();
  });

  it("Esc skips the whole request where the card owns it, and names a form's dismissal Decline", () => {
    const owned = mount(cardOf([db()]));
    fireEvent.keyDown(owned.el, { key: "Escape" });
    expect(owned.onSkip).toHaveBeenCalled();
    cleanup();
    const form = mount(cardOf([db()], { mode: "form", asker: { kind: "server", name: "Linear" } }), { ownsEscape: false });
    fireEvent.keyDown(form.el, { key: "Escape" });
    expect(form.onSkip).not.toHaveBeenCalled();
    expect(within(form.el).getByRole("button", { name: "Decline" })).toBeTruthy();
  });
});

describe("a typed answer", () => {
  it("is the field itself, sent with Enter", () => {
    const { el, onAnswer } = mount(cardOf([{ id: "name", prompt: "Name it", kind: "text" }]));
    const input = within(el).getByRole("textbox", { name: "Your answer" });
    fireEvent.change(input, { target: { value: "  Atlas  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAnswer).toHaveBeenCalledWith({ name: "Atlas" });
  });

  it("is masked when secret, kept exactly as typed, and says where it goes", () => {
    const { el, onAnswer } = mount(cardOf([{ id: "key", prompt: "Paste the deploy token", kind: "text", secret: true }]));
    const input = el.querySelector<HTMLInputElement>(".question-text-input")!;
    expect(input).toHaveAttribute("type", "password");
    expect(el.querySelector(".question-note")).toHaveTextContent("Goes to Codex only");
    fireEvent.change(input, { target: { value: " tok_live " } });
    fireEvent.click(within(el).getByRole("button", { name: /Answer/ }));
    expect(onAnswer).toHaveBeenCalledWith({ key: " tok_live " });
  });

  it("holds a number to its range before it can be sent", () => {
    const { el } = mount(cardOf([{ id: "n", prompt: "How many?", kind: "text", format: "integer", min: 1, max: 8 }]));
    const input = el.querySelector<HTMLInputElement>(".question-text-input")!;
    const answer = within(el).getByRole("button", { name: /Answer/ });
    fireEvent.change(input, { target: { value: "12" } });
    expect(answer).toBeDisabled();
    fireEvent.change(input, { target: { value: "3" } });
    expect(answer).toBeEnabled();
  });

  it("asks a date with the date field", () => {
    const { el, onAnswer } = mount(cardOf([{ id: "due", prompt: "When is it due?", kind: "time", format: "date" }]));
    const input = el.querySelector<HTMLInputElement>(".question-text-input")!;
    expect(input).toHaveAttribute("type", "date");
    fireEvent.change(input, { target: { value: "2026-10-09" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAnswer).toHaveBeenCalledWith({ due: "2026-10-09" });
  });
});

describe("who builds each step", () => {
  const models = [
    { value: "claude-opus-5-5", label: "Claude Opus 5.5", agent: "claude" as const, own: true },
    { value: "gpt-6-luna", label: "GPT-6 Luna", agent: "codex" as const },
    { value: "claude-fable-5-1", label: "Claude Fable 5.1", agent: "claude" as const },
  ];
  const steps = () => cardOf([{ id: "who", prompt: "Who builds each step?", kind: "model", options: models,
    rows: [{ id: "1", label: "Write the migration" }, { id: "2", label: "Wire the toggle" }] }]);

  it("gives every step a model chip, defaulted to the session's own", () => {
    const { el } = mount(steps());
    const chips = within(el).getAllByRole("button", { name: /^Model for / });
    expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual(["Model for Write the migration: Claude Opus 5.5", "Model for Wire the toggle: Claude Opus 5.5"]);
    expect(chips[0]).toHaveTextContent("this session");
  });

  it("answers with one model id per step, in step order — the ids agent_start takes", async () => {
    const { el, onAnswer } = mount(steps());
    fireEvent.click(within(el).getByRole("button", { name: /^Model for Wire the toggle/ }));
    // The chooser is portalled out of the card, so it carries the no-agent claim itself.
    const chooser = await screen.findByRole("dialog", { name: "Models" });
    expect(chooser).toHaveAttribute("data-no-agent", "question");
    fireEvent.click(within(chooser).getByText("GPT-6 Luna"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Models" })).toBeNull());
    fireEvent.click(within(el).getByRole("button", { name: /Continue/ }));
    expect(onAnswer).toHaveBeenCalledWith({ who: ["claude-opus-5-5", "gpt-6-luna"] });
  });

  it("answers a one-model question with the id alone", () => {
    const { el, onAnswer } = mount(cardOf([{ id: "m", prompt: "Which model?", kind: "model", options: models }]));
    fireEvent.click(within(el).getByRole("button", { name: /Continue/ }));
    expect(onAnswer).toHaveBeenCalledWith({ m: "claude-opus-5-5" });
  });
});

describe("a file", () => {
  it("searches the session's own workspace and answers with the path", async () => {
    const api = fakeApi({ projectFiles: { hits: [{ path: "src/app.ts", score: 1, segments: [{ text: "src/", match: false }, { text: "app", match: true }, { text: ".ts", match: false }] }], truncated: false, source: "git" } });
    const store = createAppStore(api);
    const onAnswer = vi.fn();
    const card = cardOf([{ id: "f", prompt: "Which file?", kind: "file" }], { workspace: "/repo" });
    render(<StoreContext.Provider value={store}><QuestionCard card={card} onAnswer={onAnswer} onSkip={vi.fn()} /></StoreContext.Provider>);
    const row = await screen.findByRole("option", { name: "src/app.ts" });
    expect(api.calls).toContain("projectFiles:/repo:");
    expect(row.querySelector("mark")).toHaveTextContent("app");
    fireEvent.click(row);
    expect(onAnswer).toHaveBeenCalledWith({ f: "src/app.ts" });
  });
});

describe("a page to open", () => {
  it("shows the whole address as text with the host set apart, and opens only on the click", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const card = cardOf([{ id: "url", prompt: "Authorize access", kind: "link", url: "http://xn--lnear-6ta.app/connect?id=1" }],
      { mode: "url", asker: { kind: "server", name: "Linear" } });
    const { el, onAnswer } = mount(card);
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelector(".question-link")).toHaveTextContent("http://xn--lnear-6ta.app/connect?id=1");
    expect(el.querySelector(".question-link-host")).toHaveTextContent("xn--lnear-6ta.app");
    expect([...el.querySelectorAll(".question-warn")].map((w) => w.textContent)).toEqual([
      expect.stringContaining("not encrypted"), expect.stringContaining("look-alike letters")]);
    expect(open).not.toHaveBeenCalled();
    act(() => { fireEvent.click(within(el).getByRole("button", { name: "Open xn--lnear-6ta.app" })); });
    expect(open).toHaveBeenCalledWith("http://xn--lnear-6ta.app/connect?id=1", "_blank");
    expect(onAnswer).toHaveBeenCalledWith({ url: "opened" });
    open.mockRestore();
  });
});

describe("the answered card — what was answered, after the fact", () => {
  const card = cardOf([
    db(),
    { id: "who", prompt: "Who builds each step?", kind: "model", rows: [{ id: "1", label: "Write the migration" }, { id: "2", label: "Wire the toggle" }],
      options: [{ value: "claude-opus-5-5", label: "Claude Opus 5.5", agent: "claude", own: true }, { value: "gpt-6-luna", label: "GPT-6 Luna", agent: "codex" }] },
    { id: "key", prompt: "Paste the deploy token", kind: "text", secret: true },
    { id: "due", prompt: "When?", kind: "time", format: "date" },
  ]);

  it("names who asked and draws each answer as a reader takes it in", () => {
    const { container } = render(<AnsweredQuestion card={card} decision="allow"
      answers={{ db: "sqlite", who: ["gpt-6-luna", "claude-opus-5-5"], key: HIDDEN_ANSWER }} />);
    const el = container.querySelector<HTMLElement>(".question-answered")!;
    expect(el.querySelector(".question-answered-head")).toHaveTextContent("Codex asked");
    const rows = [...el.querySelectorAll(".question-answered-row")].map((r) => r.textContent);
    expect(rows[0]).toBe("Which database?SQLite");
    expect(rows[1]).toContain("Write the migrationGPT-6 Luna");
    expect(rows[1]).toContain("Wire the toggleClaude Opus 5.5");
    expect(rows[2]).toBe(`Paste the deploy token${HIDDEN_ANSWER}`);
    expect(rows[3]).toBe("When?Not answered");
    // A record, not a control: nothing in it can be pressed.
    expect(el.querySelector("button")).toBeNull();
  });

  it("says a skip was a skip, a form's was a decline, and why Realm declined one itself", () => {
    const skipped = render(<AnsweredQuestion card={card} decision="deny" />);
    expect(skipped.container).toHaveTextContent("Skipped");
    cleanup();
    const refused = cardOf([db()], { mode: "form", asker: { kind: "server", name: "Linear" }, refused: "It asked for a password or a key in a form." });
    const r = render(<AnsweredQuestion card={refused} decision="deny" />);
    expect(r.container).toHaveTextContent("Linear's MCP server asked");
    expect(r.container).toHaveTextContent("Declined by Realm");
    expect(r.container).toHaveTextContent("It asked for a password or a key in a form.");
  });

  it("is drawn in the transcript once answered, and not while the live card is the question", () => {
    const model = (answered: boolean) => reduceAll([
      sessionEvent("permission_request", { requestId: "q1", toolName: "ui_ask", input: {}, title: "Which database?", suggestions: [], ask: cardOf([db()]) }),
      ...(answered ? [sessionEvent("permission_response", { requestId: "q1", decision: "allow" as const, answers: { db: "pg" } })] : []),
    ]);
    const waiting = render(<Transcript transcript={model(false)} sessionStatus="waiting_permission" onDecide={() => {}} />);
    expect(waiting.container.querySelectorAll(".question-card")).toHaveLength(1);
    expect(waiting.container.querySelector(".question-answered")).toBeNull();
    cleanup();
    const answered = render(<Transcript transcript={model(true)} sessionStatus="idle" onDecide={() => {}} />);
    expect(answered.container.querySelector(".question-card")).toBeNull();
    expect(answered.container.querySelector(".question-answered")).toHaveTextContent("Postgres");
  });
});
