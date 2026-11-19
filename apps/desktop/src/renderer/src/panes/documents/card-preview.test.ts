import { describe, expect, it } from "vitest";
import { headLines, previewSourceOf } from "./card-preview";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("a card's preview", () => {
  it("draws what the home can draw cheaply from the file's head, and the mark for the rest", () => {
    expect(previewSourceOf("plan.md", "document")).toBe("markdown");
    expect(previewSourceOf("q3.slides.md", "document")).toBe("markdown");
    expect(previewSourceOf("server.go", "code")).toBe("text");
    expect(previewSourceOf("rows.csv", "data")).toBe("text");
    expect(previewSourceOf("brief.pdf", "document")).toBe("pdf");
    expect(previewSourceOf("hero.png", "image")).toBe("thumbnail");
    expect(previewSourceOf("clip.mov", "video")).toBe("thumbnail");
    // A study guide is a page of its own scripts, and a Word file has no text in its head.
    expect(previewSourceOf("guide.html", "code")).toBeNull();
    expect(previewSourceOf("memo.docx", "document")).toBeNull();
  });

  it("ends a head cut short on its last whole line, and refuses one with a NUL in it", () => {
    // THE MUTANT: the cut ignored, and a card ends mid-word on the 4096th byte.
    expect(headLines(bytes("one\ntwo\nthr"), true)).toBe("one\ntwo");
    expect(headLines(bytes("one\ntwo\nthr"), false)).toBe("one\ntwo\nthr");
    expect(headLines(bytes("PK\u0003\u0004\u0000\u0000"), false)).toBeNull();
  });
});
