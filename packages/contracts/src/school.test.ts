import { describe, expect, it } from "vitest";
import {
  importedLectureHeader, importedLecturePath, lecturePath, lectureTemplate, localDateStamp, parseLectureFile,
  parsePlynnFilename, StartLectureResultSchema,
} from "./school";

const d = new Date(2026, 8, 2, 19, 30); // 2 Sep 2026, 7:30pm local

describe("lecture paths and template", () => {
  it("dates the file locally and slugs the title", () => {
    expect(localDateStamp(d)).toBe("2026-09-02");
    expect(lecturePath(d, "Pipelining & Hazards")).toBe("lectures/2026-09-02-pipelining-hazards.md");
  });
  it("drops the slug when the title has no word characters", () => {
    expect(lecturePath(d, "")).toBe("lectures/2026-09-02.md");
    expect(lecturePath(d, "!!!")).toBe("lectures/2026-09-02.md");
  });
  it("writes front-matter the wrap-up can read, and the three sections", () => {
    const t = lectureTemplate({ course: "EE 457", title: "Pipelining", date: d });
    expect(t.startsWith("---\ncourse: EE 457\ntitle: Pipelining\ndate: 2026-09-02\n---\n")).toBe(true);
    expect(t).toContain("# Pipelining\n");
    expect(t).toContain("## Notes\n");
    expect(t).toContain("## Questions\n");
    expect(t).toContain("## Follow-ups\n");
  });
  it("quotes a title YAML would otherwise misread and defaults an empty one", () => {
    expect(lectureTemplate({ course: "C: S", title: "a: b", date: d })).toContain('title: "a: b"');
    expect(lectureTemplate({ course: "EE 457", title: "  ", date: d })).toContain("title: Lecture 2026-09-02");
  });
});

describe("parseLectureFile", () => {
  it("prefers front-matter over the filename", () => {
    const r = parseLectureFile("lectures/2026-09-02-x.md", '---\ncourse: EE 457\ntitle: "Caches: part 2"\ndate: 2026-09-03\n---\n# ignored\n');
    expect(r).toEqual({ title: "Caches: part 2", date: "2026-09-03", hasTranscript: false });
  });
  it("falls back to the filename's date and slug, then the H1", () => {
    expect(parseLectureFile("lectures/2026-09-02-cache-coherence.md", "no headings")).toMatchObject({ title: "cache coherence", date: "2026-09-02" });
    expect(parseLectureFile("lectures/notes.md", "# Real title\n")).toMatchObject({ title: "Real title", date: null });
    expect(parseLectureFile("lectures/notes.md", "plain")).toMatchObject({ title: "notes", date: null });
  });
  it("detects a transcript section only as a heading of its own", () => {
    expect(parseLectureFile("l.md", "## Transcript\n\nwords").hasTranscript).toBe(true);
    expect(parseLectureFile("l.md", "the transcript was long").hasTranscript).toBe(false);
  });
});

describe("Plynn filenames", () => {
  it("parses Plynn's `yyyy-MM-dd HH.mm <title>` convention", () => {
    expect(parsePlynnFilename("2026-09-02 14.05 EE 457 lecture.md")).toEqual({ title: "EE 457 lecture", startedAt: "2026-09-02T14:05" });
  });
  it("keeps an unconventional name importable", () => {
    expect(parsePlynnFilename("Random notes.md")).toEqual({ title: "Random notes", startedAt: null });
  });
  it("lands under lectures/ dated from the recording, or today when undated", () => {
    expect(importedLecturePath({ title: "EE 457 lecture", startedAt: "2026-09-02T14:05" }, d)).toBe("lectures/2026-09-02-ee-457-lecture.md");
    expect(importedLecturePath({ title: "Random notes", startedAt: null }, d)).toBe("lectures/2026-09-02-random-notes.md");
  });
  it("names the source in the header, JSON-quoted so any path survives", () => {
    const h = importedLectureHeader({ course: "EE 457", meeting: { title: "L4", startedAt: "2026-09-02T14:05", file: "/x/y z.md" } });
    expect(h).toContain("source: plynn\n");
    expect(h).toContain('source_file: "/x/y z.md"\n');
    expect(h).toContain("date: 2026-09-02\n");
    expect(h.endsWith("---\n\n")).toBe(true);
  });
});

describe("schemas", () => {
  it("StartLectureResult carries what the store needs to arrange panes", () => {
    expect(StartLectureResultSchema.safeParse({ path: "lectures/a.md", documentsId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", itemId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }).success).toBe(true);
  });
});
