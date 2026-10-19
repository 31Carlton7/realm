import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Icon } from "@realm/ui";
import { RichTextEditor } from "./RichTextEditor";

afterEach(cleanup);

/** The markup a glyph draws at the toolbar's size, to compare a button's drawing against. */
const drawn = (name: Parameters<typeof Icon>[0]["name"]) => {
  const { container, unmount } = render(<Icon name={name} size={14} />);
  const svg = container.innerHTML;
  unmount();
  return svg;
};

describe("the Markdown editor's toolbar", () => {
  it("draws each button as the mark of what it does", async () => {
    // A pencil for Bold, a light bulb for Italic, "⋯" for a bulleted list and a chevron for a quote
    // were what the buttons drew, which reads as edit, ideas, more and next.
    render(<RichTextEditor text={"# Notes\n\nA line.\n"} onChange={() => {}} />);
    await screen.findByLabelText("Rich text editor", {}, { timeout: 4000 });
    const glyphs = { Bold: "bold", Italic: "italic", "Bulleted list": "list", Quote: "quote" } as const;
    const expected = Object.fromEntries(Object.entries(glyphs).map(([label, name]) => [label, drawn(name)]));
    for (const label of Object.keys(glyphs)) {
      expect(screen.getByRole("button", { name: label }).innerHTML, label).toBe(expected[label]);
    }
  });
});
