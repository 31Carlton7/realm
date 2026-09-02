import { describe, expect, it } from "vitest";
import { DOCUMENT_MAX_BYTES, documentKindFor, documentTemplate, refineDocumentKind } from "./documents";

describe("documentKindFor", () => {
  it("routes each extension to its editor", () => {
    expect(documentKindFor("notes.md")).toBe("doc");
    expect(documentKindFor("notes.markdown")).toBe("doc");
    expect(documentKindFor("q3.csv")).toBe("sheet");
    expect(documentKindFor("q3.tsv")).toBe("sheet");
    expect(documentKindFor("paper.tex")).toBe("latex");
  });

  it("treats *.slides.md and *.deck.md as decks without reading them", () => {
    expect(documentKindFor("kickoff.slides.md")).toBe("slides");
    expect(documentKindFor("kickoff.deck.markdown")).toBe("slides");
    // The compound extension must not leak into the plain case.
    expect(documentKindFor("slides.md")).toBe("doc");
    expect(documentKindFor("my.deck.notes.md")).toBe("doc");
  });

  it("is case-insensitive and path-aware", () => {
    expect(documentKindFor("a/b/REPORT.MD")).toBe("doc");
    expect(documentKindFor("/abs/Deck.SLIDES.MD")).toBe("slides");
  });

  it("answers unsupported for binaries and extensionless files", () => {
    expect(documentKindFor("image.png")).toBe("unsupported");
    expect(documentKindFor("report.docx")).toBe("unsupported");
    expect(documentKindFor("Makefile")).toBe("unsupported");
    // A dotfile is name-only; its leading dot must not read as an extension.
    expect(documentKindFor(".gitignore")).toBe("unsupported");
  });
});

describe("refineDocumentKind", () => {
  it("promotes a doc whose leading front-matter declares marp", () => {
    expect(refineDocumentKind("doc", "---\nmarp: true\n---\n\n# Hi\n")).toBe("slides");
    expect(refineDocumentKind("doc", "---\ntheme: gaia\nmarp: true\n---\n# Hi")).toBe("slides");
  });

  it("leaves an ordinary document alone", () => {
    expect(refineDocumentKind("doc", "# Just a report\n\nmarp: true is discussed here.\n")).toBe("doc");
    expect(refineDocumentKind("doc", "---\ntitle: Report\n---\n\n# Hi\n")).toBe("doc");
  });

  /** The mutant: scanning the whole file instead of the leading block. A report *about* Marp, with the
   *  directive quoted in a fence, would open as a slide deck — losing the user's document view. */
  it("ignores marp: true that is not in the leading front-matter", () => {
    expect(refineDocumentKind("doc", "# Guide\n\n```yaml\nmarp: true\n```\n")).toBe("doc");
    expect(refineDocumentKind("doc", "Intro\n\n---\nmarp: true\n---\n")).toBe("doc");
  });

  it("never changes a kind that extension already settled", () => {
    for (const k of ["sheet", "latex", "slides", "unsupported"] as const) {
      expect(refineDocumentKind(k, "---\nmarp: true\n---\n")).toBe(k);
    }
  });
});

describe("documentTemplate", () => {
  it("produces content its own classifier round-trips", () => {
    expect(refineDocumentKind(documentKindFor("d.md"), documentTemplate("slides", "Deck"))).toBe("slides");
    expect(documentTemplate("doc", "Report")).toContain("# Report");
    expect(documentTemplate("latex", "Paper")).toContain("\\documentclass{article}");
    expect(documentTemplate("latex", "Paper")).toContain("\\title{Paper}");
  });

  it("gives an unsupported file no content to write", () => {
    expect(documentTemplate("unsupported", "x")).toBe("");
  });
});

it("caps openable files at 2 MiB", () => {
  expect(DOCUMENT_MAX_BYTES).toBe(2097152);
});
