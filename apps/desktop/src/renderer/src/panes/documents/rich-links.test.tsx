import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichTextEditor } from "./RichTextEditor";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function linkIn(text: string) {
  render(<RichTextEditor text={text} onChange={() => {}} />);
  const surface = await screen.findByLabelText("Rich text editor", {}, { timeout: 4000 });
  return { surface, link: await screen.findByRole("link", { name: "the doc" }) };
}

describe("a link in the Markdown editor", () => {
  it("opens on a middle-click the way a ⌘-click opens it", async () => {
    // TipTap's link click handler only answers the main button, so a middle-click did nothing (#537).
    // THE MUTANT: check for button 0 or 2, and the middle button falls through again.
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { link } = await linkIn("See [the doc](https://example.com/doc).\n");
    fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(open).toHaveBeenCalledWith("https://example.com/doc", "_blank");
  });

  it("leaves a right-click to the context menu", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { link } = await linkIn("See [the doc](https://example.com/doc).\n");
    fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }));
    expect(open).not.toHaveBeenCalled();
  });
});
