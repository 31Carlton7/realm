import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Markdown, renderMarkdown } from "./Markdown";

afterEach(cleanup);

const NOTE = "A sentence with a footnote.[^1]\n\n[^1]: Realm does not render footnotes yet; this line shows how one reads today.";

describe("footnotes in the transcript", () => {
  it("draws a reference as a raised number that links to its note", () => {
    const doc = new DOMParser().parseFromString(renderMarkdown(NOTE), "text/html");
    const ref = doc.querySelector("sup > a[data-footnote-ref]");
    expect(ref?.textContent).toBe("1");
    expect(ref?.getAttribute("href")).toBe("#footnote-1");
    expect(doc.body.textContent).not.toContain("[^1]");
  });

  it("collects the notes into a list at the end, each linking back to where it was cited", () => {
    const doc = new DOMParser().parseFromString(renderMarkdown(NOTE), "text/html");
    const list = doc.body.lastElementChild;
    expect(list?.matches("section.footnotes")).toBe(true);
    const note = list?.querySelector("ol > li#footnote-1");
    expect(note?.textContent).toContain("this line shows how one reads today.");
    expect(note?.querySelector("a[data-footnote-backref]")?.getAttribute("href")).toBe("#footnote-ref-1");
    // The list's heading is for screen readers; the hairline above the notes already says what they are.
    expect(list?.querySelector("h2")?.className).toBe("visually-hidden");
  });

  it("numbers each message from one", () => {
    renderMarkdown("First[^a] and second[^b].\n\n[^a]: A.\n[^b]: B.");
    const doc = new DOMParser().parseFromString(renderMarkdown("Again[^b].\n\n[^b]: B again."), "text/html");
    expect(doc.querySelector("a[data-footnote-ref]")?.textContent).toBe("1");
  });

  it("leaves a reference with no note as the agent wrote it", () => {
    const out = renderMarkdown("No note for this[^9].");
    expect(out).toContain("[^9]");
    expect(out).not.toContain("footnotes");
  });

  it("jumps to the note inside the clicked message, never out to the browser", () => {
    // jsdom has no layout, so no scrollIntoView of its own: record which element asked to be shown.
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    onTestFinished(() => { Element.prototype.scrollIntoView = original; });
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    const { container } = render(<><Markdown text={"Other.[^1]\n\n[^1]: The other note."} /><Markdown text={NOTE} /></>);
    const [, second] = Array.from(container.querySelectorAll<HTMLElement>("a[data-footnote-ref]"));
    // fireEvent returns false when the default action was prevented: the anchor's target="_blank"
    // would otherwise hand "#footnote-1" to the OS browser.
    expect(fireEvent.click(second!)).toBe(false);
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]!.textContent).toContain("how one reads today");

    const back = container.querySelectorAll<HTMLElement>("a[data-footnote-backref]")[1]!;
    expect(fireEvent.click(back)).toBe(false);
    expect(scrolled[1]).toBe(second);
  });
});
