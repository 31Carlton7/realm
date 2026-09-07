import { describe, expect, it } from "vitest";
import { AgentKindSchema } from "./entities";
import { AGENT_META } from "./presets";
import {
  attachmentDisposition, attachmentNote, attachmentSummary, basenameOf, DEFAULT_MIME,
  isImageMime, isOpenablePath, MAX_ATTACHMENT_BYTES, mimeForPath,
} from "./attachments";

const KINDS = AgentKindSchema.options;

describe("mimeForPath", () => {
  it("maps known extensions, case-insensitively", () => {
    expect(mimeForPath("/a/b/shot.png")).toBe("image/png");
    expect(mimeForPath("/a/b/SHOT.PNG")).toBe("image/png");
    expect(mimeForPath("photo.JPEG")).toBe("image/jpeg");
    expect(mimeForPath("/x/report.pdf")).toBe("application/pdf");
    expect(mimeForPath("notes.md")).toBe("text/markdown");
  });
  it("falls back to octet-stream for unknown, missing and empty extensions", () => {
    expect(mimeForPath("/a/Makefile")).toBe(DEFAULT_MIME);
    expect(mimeForPath("/a/archive.qqq")).toBe(DEFAULT_MIME);
    expect(mimeForPath("/a/trailing.")).toBe(DEFAULT_MIME);
    // A dotfile is a name, not an extension: ".env" must not read as an "env" type.
    expect(mimeForPath("/a/.env")).toBe(DEFAULT_MIME);
  });
  it("reads the extension of the LAST segment, not of a directory above it", () => {
    expect(mimeForPath("/home/me.png/notes")).toBe(DEFAULT_MIME);
    expect(mimeForPath("/home/v1.2/shot.png")).toBe("image/png");
  });
});

describe("basenameOf", () => {
  it("takes the last segment for both separators and ignores trailing slashes", () => {
    expect(basenameOf("/a/b/c.png")).toBe("c.png");
    expect(basenameOf("C:\\Users\\me\\c.png")).toBe("c.png");
    expect(basenameOf("/a/b/")).toBe("b");
    expect(basenameOf("bare.png")).toBe("bare.png");
  });
});

describe("isImageMime", () => {
  it("is true only for the image/ family", () => {
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("image/svg+xml")).toBe(true);
    expect(isImageMime("application/pdf")).toBe(false);
    expect(isImageMime("text/plain")).toBe(false);
    // Not a substring test: a mime that merely mentions "image" is not an image.
    expect(isImageMime("application/x-image-thing")).toBe(false);
  });
});

describe("attachmentDisposition mirrors the adapters", () => {
  it("Claude inlines images and DROPS everything else (claude-adapter.ts `continue`)", () => {
    expect(attachmentDisposition("claude", "image/png")).toBe("inline");
    expect(attachmentDisposition("claude", "application/pdf")).toBe("path");
    expect(attachmentDisposition("claude", "text/plain")).toBe("path");
  });
  it("Codex takes a path for everything (localImage / the Attached files list)", () => {
    expect(attachmentDisposition("codex", "image/png")).toBe("path");
    expect(attachmentDisposition("codex", "application/pdf")).toBe("path");
  });
  it("ACP agents get a link — the guaranteed floor, whatever they advertise", () => {
    for (const kind of ["acp:cursor", "acp:gemini"] as const) {
      expect(attachmentDisposition(kind, "image/png")).toBe("link");
      expect(attachmentDisposition(kind, "application/pdf")).toBe("link");
    }
  });
  it("the fake adapter reads no attachments at all", () => {
    expect(attachmentDisposition("fake", "image/png")).toBe("ignored");
    expect(attachmentDisposition("fake", "application/pdf")).toBe("ignored");
  });
  it("covers every registered agent kind", () => {
    for (const kind of KINDS) expect(attachmentDisposition(kind, "image/png")).toBeTruthy();
  });
});

describe("attachmentNote", () => {
  it("names the agent it is talking about, for every kind", () => {
    for (const kind of KINDS) {
      expect(attachmentNote(kind, "image/png")).toContain(AGENT_META[kind].label);
      expect(attachmentNote(kind, "application/pdf")).toContain(AGENT_META[kind].label);
    }
  });
  it("is different per agent for the SAME file — the whole point of showing it", () => {
    const pdf = "application/pdf";
    const notes = KINDS.map((k) => attachmentNote(k, pdf));
    expect(attachmentNote("claude", pdf)).toMatch(/file path/);
    expect(attachmentNote("codex", pdf)).toMatch(/file path/);
    expect(attachmentNote("acp:cursor", pdf)).toMatch(/link/);
    expect(new Set(notes).size).toBeGreaterThan(1);
  });
  it("distinguishes an ignored image from an ignored non-image", () => {
    // `fake` is the only kind left that ignores anything, and it ignores everything — so the
    // non-image wording has no live speaker. It is kept because the branch is reachable the moment
    // any kind's `image` disposition becomes `ignored` while its `other` is not.
    expect(attachmentNote("fake", "image/png")).toMatch(/ignores attachments/);
    expect(attachmentNote("fake", "image/png")).not.toMatch(/non-image/);
    expect(attachmentNote("claude", "text/plain")).toMatch(/file path/);
  });
});

describe("attachmentSummary", () => {
  const a = (path: string, mime: string) => ({ path, mime });

  it("groups by disposition and lists the basenames each line covers", () => {
    const rows = attachmentSummary("fake", [
      a("/x/one.png", "image/png"), a("/x/report.pdf", "application/pdf"),
      a("/x/two.png", "image/png"), a("/x/notes.txt", "text/plain"),
    ]);
    expect(rows.map((r) => r.disposition)).toEqual(["ignored"]);
    expect(rows[0]!.files).toEqual(["one.png", "report.pdf", "two.png", "notes.txt"]);
  });

  it("hands the note to the row as a lead-in, so the filenames finish the sentence", () => {
    // The reported bug read as one run-on string — "…will never see them.example.pdf" — because the
    // sentence stopped dead in front of the list it was introducing. The chip tooltip still gets the
    // standalone sentence; only the row that is followed by filenames is re-punctuated.
    const [row] = attachmentSummary("fake", [a("/x/example.pdf", "application/pdf")]);
    expect(row!.note.endsWith(":")).toBe(true);
    expect(row!.note).not.toMatch(/\.$/);
    expect(attachmentNote("fake", "application/pdf").endsWith(".")).toBe(true);
  });

  it("says nothing about a file the agent will simply read", () => {
    // The good case earns no row: attaching a screenshot to Claude leaves the prompter silent.
    expect(attachmentSummary("claude", [a("/a.png", "image/png"), a("/b.png", "image/png")])).toEqual([]);
  });

  it("collapses repeats into one line, never one line per file", () => {
    const rows = attachmentSummary("fake", [a("/a.pdf", "application/pdf"), a("/b.txt", "text/plain")]);
    expect(rows).toHaveLength(1); // both are dropped the same way, so they share the one sentence
    expect(rows[0]!.files).toEqual(["a.pdf", "b.txt"]);
  });

  it("is empty with nothing attached", () => {
    expect(attachmentSummary("claude", [])).toEqual([]);
  });

  it("says nothing at all for Claude any more — it no longer drops a file on the floor", () => {
    // Claude reads images inline and is handed every other file's PATH in the message text, exactly
    // as Codex is (claude-adapter.ts `fileListFor`). Nothing is silently discarded, so nothing needs
    // announcing before send. The mutant: putting `other: "ignored"` back, which resurrects both the
    // warning row and the dropped file behind it.
    expect(attachmentSummary("claude", [a("/x/report.pdf", "application/pdf"), a("/x/shot.png", "image/png")])).toEqual([]);
  });

  it("says nothing about a handoff the agent will complete itself — a path or a link is not a warning", () => {
    // The named mutant: put "path" and "link" back into NOTICE_ORDER and every Codex or Cursor message
    // with a file grows a sentence of narration under its chips. The chip's tooltip still carries it.
    const files = [a("/x/report.pdf", "application/pdf"), a("/x/shot.png", "image/png")];
    expect(attachmentSummary("codex", files)).toEqual([]);
    expect(attachmentSummary("acp:cursor", files)).toEqual([]);
    expect(attachmentNote("codex", "application/pdf")).toMatch(/file path/);
    expect(attachmentNote("acp:cursor", "application/pdf")).toMatch(/link/);
  });

  it("still warns for the one agent that drops the file on the floor", () => {
    expect(attachmentSummary("fake", [a("/x/report.pdf", "application/pdf")]).map((r) => r.disposition)).toEqual(["ignored"]);
    expect(attachmentSummary("fake", [a("/x/shot.png", "image/png")]).map((r) => r.disposition)).toEqual(["ignored"]);
  });
});

describe("MAX_ATTACHMENT_BYTES", () => {
  it("is the 20 MB ceiling the Claude adapter throws above", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("isOpenablePath", () => {
  it("accepts every document type the mime table names", () => {
    for (const p of ["/x/a.pdf", "/x/a.png", "/x/a.mp4", "/x/a.csv", "/x/a.ts", "/x/a.md", "/x/a.zip"]) {
      expect(isOpenablePath(p), p).toBe(true);
    }
  });
  it("refuses what the table does not name — the bundles macOS would RUN rather than show", () => {
    // `open Thing.app` launches it. The table not knowing those extensions is the whole gate, so
    // this is the assertion that keeps `attachment:open` off them.
    for (const p of ["/x/Thing.app", "/x/run.command", "/x/h.tool", "/x/a.workflow", "/x/blob.bin", "/x/noext", "/x/.env"]) {
      expect(isOpenablePath(p), p).toBe(false);
    }
  });
  it("agrees with mimeForPath — it IS that question, and both sides of the bridge ask it", () => {
    for (const p of ["/x/a.pdf", "/x/Thing.app", "/x/noext"]) {
      expect(isOpenablePath(p), p).toBe(mimeForPath(p) !== DEFAULT_MIME);
    }
  });
});
