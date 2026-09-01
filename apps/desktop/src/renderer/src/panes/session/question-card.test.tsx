import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { QuestionCard, parseQuestions, type Question } from "./QuestionCard";

afterEach(() => cleanup());

const q = (over: Partial<Question> = {}): Question => ({
  question: "Which database?", header: "Database", multiSelect: false,
  options: [{ label: "Postgres", description: "Relational, boring, correct" }, { label: "SQLite", description: "Local, zero-ops" }],
  ...over,
});

const rowsOf = (card: HTMLElement) => within(card).getAllByRole("button").filter((b) => b.classList.contains("question-option"));

describe("parseQuestions — only a genuinely question-shaped payload gets the question card", () => {
  it("accepts a well-formed AskUserQuestion payload", () => {
    const parsed = parseQuestions("AskUserQuestion", { questions: [{ question: "Pick?", header: "H", multiSelect: false, options: [{ label: "A", description: "d" }, { label: "B" }] }] });
    expect(parsed).toEqual([{ question: "Pick?", header: "H", multiSelect: false, options: [{ label: "A", description: "d" }, { label: "B" }] }]);
  });
  it("refuses any other tool, so a Bash call can never render as a question", () => {
    expect(parseQuestions("Bash", { questions: [{ question: "Pick?", options: [{ label: "A" }] }] })).toBeNull();
  });
  it.each([
    ["no questions key", {}],
    ["questions not an array", { questions: "nope" }],
    ["empty questions", { questions: [] }],
    ["question missing text", { questions: [{ header: "H", options: [{ label: "A" }] }] }],
    ["question with no options", { questions: [{ question: "Pick?", options: [] }] }],
    ["option missing a label", { questions: [{ question: "Pick?", options: [{ description: "d" }] }] }],
  ])("falls back (null) on malformed input: %s", (_name, input) => {
    expect(parseQuestions("AskUserQuestion", input as Record<string, unknown>)).toBeNull();
  });
});

describe("QuestionCard", () => {
  it("shows the question and its options as real labelled rows — not a JSON blob", () => {
    const { container } = render(<QuestionCard questions={[q()]} onAnswer={vi.fn()} onSkip={vi.fn()} />);
    const card = container.querySelector<HTMLElement>(".question-card")!;
    expect(within(card).getByRole("heading")).toHaveTextContent("Which database?");
    const rows = rowsOf(card);
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Postgres", "SQLite", "Something else"]);
    expect(card).toHaveTextContent("Relational, boring, correct");
    expect(card.querySelector(".question-num")).toHaveTextContent("1");
  });

  it("clicking an option answers with that option's label, keyed by the question text", () => {
    const onAnswer = vi.fn();
    const { container } = render(<QuestionCard questions={[q()]} onAnswer={onAnswer} onSkip={vi.fn()} />);
    fireEvent.click(rowsOf(container.querySelector<HTMLElement>(".question-card")!)[1]!);
    expect(onAnswer).toHaveBeenCalledWith({ "Which database?": "SQLite" });
  });

  it("a number key picks that option outright", () => {
    const onAnswer = vi.fn();
    const { container } = render(<QuestionCard questions={[q()]} onAnswer={onAnswer} onSkip={vi.fn()} />);
    fireEvent.keyDown(container.querySelector(".question-card")!, { key: "1" });
    expect(onAnswer).toHaveBeenCalledWith({ "Which database?": "Postgres" });
  });

  it("several questions are answered one at a time, and every answer arrives together at the end", () => {
    const onAnswer = vi.fn();
    const two = [q(), q({ question: "Which runtime?", options: [{ label: "Node" }, { label: "Bun" }] })];
    const { container } = render(<QuestionCard questions={two} onAnswer={onAnswer} onSkip={vi.fn()} />);
    const card = container.querySelector<HTMLElement>(".question-card")!;
    expect(card.querySelector(".question-pager")).toHaveTextContent("1 of 2");

    fireEvent.click(rowsOf(card)[0]!); // Postgres
    expect(onAnswer).not.toHaveBeenCalled(); // still one question to go — nothing is submitted yet
    expect(within(card).getByRole("heading")).toHaveTextContent("Which runtime?");
    expect(card.querySelector(".question-pager")).toHaveTextContent("2 of 2");

    fireEvent.click(rowsOf(card)[1]!); // Bun
    expect(onAnswer).toHaveBeenCalledWith({ "Which database?": "Postgres", "Which runtime?": "Bun" });
  });

  it("multi-select toggles rather than advancing, and Continue submits the picks comma-joined", () => {
    const onAnswer = vi.fn();
    const { container } = render(<QuestionCard questions={[q({ multiSelect: true })]} onAnswer={onAnswer} onSkip={vi.fn()} />);
    const card = container.querySelector<HTMLElement>(".question-card")!;
    const cont = within(card).getByRole("button", { name: /Continue/ });
    expect(cont).toBeDisabled(); // nothing picked yet

    fireEvent.click(rowsOf(card)[0]!);
    fireEvent.click(rowsOf(card)[1]!);
    expect(onAnswer).not.toHaveBeenCalled(); // a toggle is not an answer
    expect(rowsOf(card)[0]!).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(cont);
    expect(onAnswer).toHaveBeenCalledWith({ "Which database?": "Postgres, SQLite" });
  });

  it("a re-clicked multi-select row is un-picked", () => {
    const onAnswer = vi.fn();
    const { container } = render(<QuestionCard questions={[q({ multiSelect: true })]} onAnswer={onAnswer} onSkip={vi.fn()} />);
    const card = container.querySelector<HTMLElement>(".question-card")!;
    fireEvent.click(rowsOf(card)[0]!);
    fireEvent.click(rowsOf(card)[1]!);
    fireEvent.click(rowsOf(card)[0]!); // un-pick Postgres
    fireEvent.click(within(card).getByRole("button", { name: /Continue/ }));
    expect(onAnswer).toHaveBeenCalledWith({ "Which database?": "SQLite" });
  });

  it("'Something else' takes free text — the escape hatch the tool's own schema promises", () => {
    const onAnswer = vi.fn();
    const { container } = render(<QuestionCard questions={[q()]} onAnswer={onAnswer} onSkip={vi.fn()} />);
    const card = container.querySelector<HTMLElement>(".question-card")!;
    fireEvent.click(within(card).getByRole("button", { name: "Something else" }));
    const input = within(card).getByRole("textbox", { name: "Your answer" });
    fireEvent.change(input, { target: { value: "DuckDB" } });
    fireEvent.click(within(card).getByRole("button", { name: "Answer" }));
    expect(onAnswer).toHaveBeenCalledWith({ "Which database?": "DuckDB" });
  });

  it("Esc skips the whole request — the agent asked and got no answer, which is not any answer it offered", () => {
    const onSkip = vi.fn(); const onAnswer = vi.fn();
    const { container } = render(<QuestionCard questions={[q()]} onAnswer={onAnswer} onSkip={onSkip} />);
    fireEvent.keyDown(container.querySelector(".question-card")!, { key: "Escape" });
    expect(onSkip).toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("Esc inside the free-text row backs out to the options instead of skipping the request", () => {
    const onSkip = vi.fn();
    const { container } = render(<QuestionCard questions={[q()]} onAnswer={vi.fn()} onSkip={onSkip} />);
    const card = container.querySelector<HTMLElement>(".question-card")!;
    fireEvent.click(within(card).getByRole("button", { name: "Something else" }));
    fireEvent.keyDown(card, { key: "Escape" });
    expect(onSkip).not.toHaveBeenCalled();
    expect(within(card).getByRole("button", { name: "Something else" })).toBeInTheDocument();
  });

  it("Skip on the only question, with nothing answered, is a skip of the request", () => {
    const onSkip = vi.fn(); const onAnswer = vi.fn();
    const { container } = render(<QuestionCard questions={[q()]} onAnswer={onAnswer} onSkip={onSkip} />);
    fireEvent.click(container.querySelector<HTMLElement>(".question-skip")!);
    expect(onSkip).toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("skipping the last of several still submits the answers already given", () => {
    const onAnswer = vi.fn(); const onSkip = vi.fn();
    const two = [q(), q({ question: "Which runtime?", options: [{ label: "Node" }, { label: "Bun" }] })];
    const { container } = render(<QuestionCard questions={two} onAnswer={onAnswer} onSkip={onSkip} />);
    const card = container.querySelector<HTMLElement>(".question-card")!;
    fireEvent.click(rowsOf(card)[0]!); // answer the first
    fireEvent.click(card.querySelector<HTMLElement>(".question-skip")!); // skip the second
    expect(onAnswer).toHaveBeenCalledWith({ "Which database?": "Postgres" });
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("arrow keys move the selection across the options and the free-text row", () => {
    const { container } = render(<QuestionCard questions={[q()]} onAnswer={vi.fn()} onSkip={vi.fn()} />);
    const card = container.querySelector<HTMLElement>(".question-card")!;
    const selected = () => card.querySelector<HTMLElement>(".question-option[data-selected]")!.getAttribute("aria-label");
    expect(selected()).toBe("Postgres");
    fireEvent.keyDown(card, { key: "ArrowDown" });
    expect(selected()).toBe("SQLite");
    fireEvent.keyDown(card, { key: "ArrowDown" });
    expect(selected()).toBe("Something else");
    fireEvent.keyDown(card, { key: "ArrowDown" }); // wraps
    expect(selected()).toBe("Postgres");
    fireEvent.keyDown(card, { key: "ArrowUp" });
    expect(selected()).toBe("Something else");
  });
});
