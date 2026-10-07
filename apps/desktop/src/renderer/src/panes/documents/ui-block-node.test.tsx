import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichTextEditor } from "./RichTextEditor";
import { docSchema, openFence, parseMarkdown, serializeMarkdown } from "./markdown-model";

/**
 * The blocks an agent writes, in a Markdown document's rich view (`UiBlockNode.tsx`). What matters
 * beyond the transcript's tests: the file is never touched by drawing it, a fence the file has not
 * closed stays code, and the source is there to edit.
 */

vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 10 10"><text>x</text></svg>', diagramType: "flowchart-v2" })) } }));
afterEach(cleanup);

const COMPARE = '```realm-compare\n{"options": ["Postgres", "SQLite"], "pick": "SQLite", "rows": [{"label": "Setup", "values": ["A server", "A file"]}]}\n```';
const BROKEN = '```realm-chart\n{"kind": "lines", "title": "Startup", "x": ["1", "2"], "series": [{"label": "Cold", "values": [1]}]}\n```';
const DOC = `# Notes\n\n${COMPARE}\n\nThen:\n\n${BROKEN}\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n`;

const mount = async (text: string) => {
  const onChange = vi.fn();
  const view = render(<RichTextEditor text={text} onChange={onChange} />);
  await screen.findByLabelText("Rich text editor", {}, { timeout: 4000 });
  return { ...view, onChange };
};

describe("a drawn block in a document", () => {
  it("draws a closed block fence in place of its code, and leaves every other code block as code", async () => {
    const { container } = await mount(DOC);
    await waitFor(() => expect(container.querySelector('.ui-block[data-kind="compare"]')).not.toBeNull());
    const node = container.querySelector(".ui-block-node")!;
    expect(node.querySelector("pre")).toHaveAttribute("hidden");
    expect(container.querySelector('.ui-block[data-kind="compare"] th[data-pick]')?.textContent).toBe("RecommendedSQLite");
    // The TypeScript fence is ProseMirror's own code block, untouched.
    expect(container.querySelector("pre code.language-ts")?.textContent).toBe("const a = 1;");
  });

  it("leaves a body that does not parse as its code, with the reason over it", async () => {
    const { container } = await mount(DOC);
    await waitFor(() => expect(container.querySelector(".ui-block-node-reason")?.textContent).toBe('Not drawn — "Cold" has 1 values for 2 x labels'));
    const reason = container.querySelector(".ui-block-node-reason")!;
    expect(reason.closest(".ui-block-node")!.querySelector("pre")).not.toHaveAttribute("hidden");
  });

  it("never writes to the file for drawing it", async () => {
    // THE MUTANT: a node view that re-serialized its block on mount would rewrite the file on open.
    const { onChange } = await mount(DOC);
    await new Promise((r) => setTimeout(r, 50));
    expect(onChange).not.toHaveBeenCalled();
    expect(serializeMarkdown(parseMarkdown(DOC, docSchema))).toBe(DOC);
  });

  it("keeps a fence the file has not closed as code — an agent still writing it", async () => {
    const open = `# Notes\n\n\`\`\`realm-compare\n{"options": ["Postgres", "SQLite"], "rows": [{"label": "Setup", "values": ["A server", "A file"]}]}\n`;
    expect(openFence(parseMarkdown(open, docSchema).lastChild!)).toBe(true);
    expect(openFence(parseMarkdown(DOC, docSchema).child(1))).toBe(false);
    const { container } = await mount(open);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector(".ui-block")).toBeNull();
    expect(container.querySelector(".ui-block-node pre")).not.toHaveAttribute("hidden");
  });

  it("shows the source on Edit source, and hides it again on Done", async () => {
    const { container } = await mount(DOC);
    const edit = await screen.findByRole("button", { name: "Edit source" });
    expect(edit).toHaveAttribute("aria-pressed", "false");
    await act(async () => { fireEvent.click(edit); });
    await waitFor(() => expect(container.querySelector(".ui-block-node pre")).not.toHaveAttribute("hidden"));
    expect(screen.getByRole("button", { name: "Edit source" })).toHaveAttribute("aria-pressed", "true");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Edit source" })); });
    await waitFor(() => expect(container.querySelector(".ui-block-node pre")).toHaveAttribute("hidden"));
  });
});
