import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ToolCard, RESULT_CLAMP } from "./ToolCard";
import type { Block } from "./transcript-model";

type ToolBlock = Extract<Block, { kind: "tool" }>;
const block = (content: string, isError = false): ToolBlock =>
  ({ kind: "tool", toolUseId: "t1", name: "Bash", input: { command: "ls" }, result: { content, isError }, ts: 0 });

const mount = (content: string) => render(<ToolCard block={block(content)} sessionStatus="idle" />);
const openCard = () => fireEvent.click(screen.getByRole("button", { name: /Bash tool call/ }));
const resultWell = () => document.querySelector<HTMLElement>(".tool-section:last-child .tool-well")!;

afterEach(() => cleanup());

describe("ToolCard output clamp (A-M2)", () => {
  it("a result at exactly the clamp limit renders in full with no expander", () => {
    mount("x".repeat(RESULT_CLAMP));
    openCard();
    expect(resultWell().textContent).toHaveLength(RESULT_CLAMP);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("one char over the limit clamps to exactly the limit and offers 'Show all (N KB)'; clicking expands to the full text", () => {
    const content = "a".repeat(RESULT_CLAMP) + "Z";
    mount(content);
    openCard();
    expect(resultWell().textContent).toHaveLength(RESULT_CLAMP);
    expect(resultWell().textContent!.endsWith("Z")).toBe(false);
    const expand = screen.getByRole("button", { name: `Show all (${Math.ceil(content.length / 1024)} KB)` });
    fireEvent.click(expand);
    expect(resultWell().textContent).toHaveLength(content.length);
    expect(resultWell().textContent!.endsWith("Z")).toBe(true);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});

describe("ToolCard copy buttons (A-M3)", () => {
  it("copies the full input/result text to the clipboard — the untruncated text, even while clamped", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const content = "b".repeat(RESULT_CLAMP) + "END";
    mount(content);
    openCard();
    fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
    expect(writeText).toHaveBeenCalledWith(content);
    fireEvent.click(screen.getByRole("button", { name: "Copy input" }));
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("ls"));
  });
});
