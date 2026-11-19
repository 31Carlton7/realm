import { afterEach, describe, expect, it, vi } from "vitest";

// pdf.js is not loaded in jsdom; a first page that never comes is what the turn's limit is for.
const firstPagePicture = vi.hoisted(() => vi.fn((): Promise<string | null> => new Promise(() => {})));
vi.mock("./pdf-source", () => ({ firstPagePicture }));

import { JOB_LIMIT_MS, TEXT_HEAD, headLines, loadCardPreview, previewSourceOf, resetCardPreviews } from "./card-preview";

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

describe("drawing a card's preview", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetCardPreviews(); });
  const files = (mtime: () => number) => {
    const readRange = vi.fn(async () => bytes("# Plan\n\nShip it.\n"));
    vi.stubGlobal("realm", { files: { readRange, stat: vi.fn(async (path: string) => ({ path, size: 18, mtimeMs: mtime() })) } });
    return readRange;
  };

  it("gives back a turn a PDF never answers, so the cards after it still draw", async () => {
    /* Two PDFs whose first pages never come take both turns. THE MUTANT: no limit on a turn, and no
       Markdown, text or PDF card draws again for the life of the window. */
    vi.useFakeTimers();
    files(() => 1);
    const a = loadCardPreview("/w/a.pdf", "pdf");
    const b = loadCardPreview("/w/b.pdf", "pdf");
    const md = loadCardPreview("/w/plan.md", "markdown");
    await vi.advanceTimersByTimeAsync(JOB_LIMIT_MS + 50);
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(await md).toMatchObject({ kind: "markdown" });
  });

  it("reads a file again when it has changed since its preview was drawn, and not when it has not", async () => {
    // THE MUTANT: the preview kept by path alone, so a plan the agent rewrote shows its old top.
    let mtime = 100;
    const readRange = files(() => mtime);
    await loadCardPreview("/w/plan.md", "markdown");
    await loadCardPreview("/w/plan.md", "markdown");
    expect(readRange.mock.calls).toEqual([["/w/plan.md", 0, TEXT_HEAD]]);
    mtime = 200;
    await loadCardPreview("/w/plan.md", "markdown");
    expect(readRange).toHaveBeenCalledTimes(2);
  });
});
