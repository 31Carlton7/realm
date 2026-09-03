import { describe, expect, it } from "vitest";
import { DOCUMENT_MAX_BYTES, documentExtension, documentKindFor, documentStem, documentTemplate, freeFileName, refineDocumentKind } from "./documents";

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

// ---- Plan 22: preview kinds, guide template, progress sidecar -----------------------------------
import {
  documentKindFor as kindFor22, documentTemplate as template22, emptyGuideProgress, guideTemplate, progressSidecarPath,
  recordGuideAttempt, slugify, weakTopics, GUIDE_PROGRESS_MAX_ATTEMPTS, GuideProgressSchema,
} from "./documents";

describe("Plan 22 — html and pdf kinds", () => {
  it("classifies .html/.htm as html and .pdf as pdf, case-insensitively", () => {
    expect(kindFor22("guides/cache.html")).toBe("html");
    expect(kindFor22("GUIDE.HTM")).toBe("html");
    expect(kindFor22("slides/lecture4.PDF")).toBe("pdf");
    expect(kindFor22("archive.zip")).toBe("unsupported");
  });
  it("starts a guide with the runtime's markup and the KaTeX opt-in, escaped", () => {
    const t = template22("html", 'Caches & "coherence"');
    expect(t).toContain('<meta name="realm-helpers" content="katex">');
    expect(t).toContain("<title>Caches &amp; &quot;coherence&quot;</title>");
    expect(t).toContain('class="rg-quiz" data-topic="caches-coherence"');
    expect(t).toContain('class="rg-check"');
    expect(t).not.toContain("guide.js"); // the server injects the runtime; the file stays portable
    expect(guideTemplate("!!!")).toContain('data-topic="topic"');
  });
});

describe("slugify", () => {
  it("lowercases, strips diacritics, collapses runs, trims hyphens, caps length", () => {
    expect(slugify("Pipelining & Hazards")).toBe("pipelining-hazards");
    expect(slugify("  Émile's   café ")).toBe("emile-s-cafe");
    expect(slugify("---")).toBe("");
    expect(slugify("a".repeat(100))).toHaveLength(64);
  });
});

describe("guide progress", () => {
  it("hides the sidecar beside the guide", () => {
    expect(progressSidecarPath("guides/cache.html")).toBe("guides/.cache.html.progress.json");
    expect(progressSidecarPath("cache.html")).toBe(".cache.html.progress.json");
  });
  it("folds attempts, deriving best and last", () => {
    let p = emptyGuideProgress();
    p = recordGuideAttempt(p, "caches", { at: 1, correct: 2, total: 4 });
    p = recordGuideAttempt(p, "caches", { at: 2, correct: 4, total: 4 });
    p = recordGuideAttempt(p, "caches", { at: 3, correct: 3, total: 4 });
    expect(p.topics.caches).toMatchObject({ best: 1, last: 0.75 });
    expect(p.topics.caches!.attempts).toHaveLength(3);
    expect(GuideProgressSchema.safeParse(p).success).toBe(true);
  });
  it("is pure — the input is not mutated", () => {
    const p = emptyGuideProgress();
    recordGuideAttempt(p, "t", { at: 1, correct: 1, total: 1 });
    expect(p.topics).toEqual({});
  });
  it("caps the history so a semester of retakes cannot grow the sidecar unbounded", () => {
    let p = emptyGuideProgress();
    for (let i = 0; i < GUIDE_PROGRESS_MAX_ATTEMPTS + 10; i++) p = recordGuideAttempt(p, "t", { at: i, correct: 1, total: 2 });
    expect(p.topics.t!.attempts).toHaveLength(GUIDE_PROGRESS_MAX_ATTEMPTS);
    expect(p.topics.t!.attempts[0]!.at).toBe(10); // oldest dropped, not newest
  });
  it("names weak topics by the LAST attempt, sorted", () => {
    let p = emptyGuideProgress();
    p = recordGuideAttempt(p, "z", { at: 1, correct: 1, total: 4 });
    p = recordGuideAttempt(p, "a", { at: 1, correct: 4, total: 4 });
    p = recordGuideAttempt(p, "a", { at: 2, correct: 1, total: 4 }); // best is 100%, last is 25%
    p = recordGuideAttempt(p, "m", { at: 1, correct: 4, total: 5 });
    expect(weakTopics(p)).toEqual(["a", "z"]);
  });
});

describe("freeFileName", () => {
  it("hands out the bare name when nothing is in the way", () => {
    expect(freeFileName("Untitled document", "md", [])).toBe("Untitled document.md");
  });
  it("counts from 2, so the first two documents read as a pair rather than as 1 and 2", () => {
    expect(freeFileName("Untitled document", "md", ["Untitled document.md"])).toBe("Untitled document 2.md");
    expect(freeFileName("Untitled document", "md", ["Untitled document.md", "Untitled document 2.md"]))
      .toBe("Untitled document 3.md");
  });
  it("fills a gap rather than always appending", () => {
    expect(freeFileName("Untitled document", "md", ["Untitled document.md", "Untitled document 3.md"]))
      .toBe("Untitled document 2.md");
  });
  it("is case-insensitive — the create would fail on a macOS filesystem otherwise", () => {
    expect(freeFileName("Untitled document", "md", ["untitled DOCUMENT.md"])).toBe("Untitled document 2.md");
  });
  it("only collides within its own extension: a sheet and a doc may share a stem", () => {
    expect(freeFileName("Untitled document", "csv", ["Untitled document.md"])).toBe("Untitled document.csv");
  });
  it("honours a multi-part extension whole", () => {
    expect(freeFileName("Untitled presentation", "slides.md", ["Untitled presentation.slides.md"]))
      .toBe("Untitled presentation 2.slides.md");
  });
});

describe("documentExtension / documentStem", () => {
  it("splits an ordinary name on its last dot", () => {
    expect(documentExtension("notes/Q3 review.md")).toBe("md");
    expect(documentStem("notes/Q3 review.md")).toBe("Q3 review");
  });
  it("keeps a deck's compound extension whole — splitting it would demote the deck to a document", () => {
    expect(documentExtension("Q3.slides.md")).toBe("slides.md");
    expect(documentStem("Q3.slides.md")).toBe("Q3");
    expect(documentKindFor(`${documentStem("Q3.slides.md")} renamed.${documentExtension("Q3.slides.md")}`)).toBe("slides");
    expect(documentExtension("plan.deck.markdown")).toBe("deck.markdown");
  });
  it("only the LAST dot is the extension elsewhere — a dotted stem stays part of the name", () => {
    expect(documentStem("Q3.review.md")).toBe("Q3.review");
  });
  it("answers empty for a name with no extension, and leaves the whole name as the stem", () => {
    expect(documentExtension("README")).toBe("");
    expect(documentStem("README")).toBe("README");
    expect(documentExtension(".gitignore")).toBe(""); // a leading dot is not an extension
  });
});
