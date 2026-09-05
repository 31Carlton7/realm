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
    expect(attachmentDisposition("claude", "application/pdf")).toBe("ignored");
    expect(attachmentDisposition("claude", "text/plain")).toBe("ignored");
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
    expect(attachmentNote("claude", pdf)).toMatch(/ignores non-image/);
    expect(attachmentNote("codex", pdf)).toMatch(/file path/);
    expect(attachmentNote("acp:cursor", pdf)).toMatch(/link/);
    expect(new Set(notes).size).toBeGreaterThan(1);
  });
  it("distinguishes an ignored image from an ignored non-image", () => {
    expect(attachmentNote("fake", "image/png")).toMatch(/ignores attachments/);
    expect(attachmentNote("fake", "image/png")).not.toMatch(/non-image/);
    expect(attachmentNote("claude", "text/plain")).toMatch(/ignores non-image attachments/);
  });
});

describe("attachmentSummary", () => {
  const a = (path: string, mime: string) => ({ path, mime });

  it("groups by disposition and lists the basenames each line covers", () => {
    const rows = attachmentSummary("claude", [
      a("/x/one.png", "image/png"), a("/x/report.pdf", "application/pdf"),
      a("/x/two.png", "image/png"), a("/x/notes.txt", "text/plain"),
    ]);
    expect(rows.map((r) => r.disposition)).toEqual(["ignored"]);
    expect(rows[0]!.files).toEqual(["report.pdf", "notes.txt"]);
  });

  it("says nothing about a file the agent will simply read", () => {
    // The good case earns no row: attaching a screenshot to Claude leaves the prompter silent.
    expect(attachmentSummary("claude", [a("/a.png", "image/png"), a("/b.png", "image/png")])).toEqual([]);
  });

  it("collapses repeats into one line, never one line per file", () => {
    const rows = attachmentSummary("codex", [a("/a.png", "image/png"), a("/b.png", "image/png"), a("/c.pdf", "application/pdf")]);
    expect(rows).toHaveLength(1); // codex treats both classes the same way
    expect(rows[0]!.files).toEqual(["a.png", "b.png", "c.pdf"]);
  });

  it("is empty with nothing attached", () => {
    expect(attachmentSummary("claude", [])).toEqual([]);
  });

  it("reports the SAME files differently per agent", () => {
    const files = [a("/x/report.pdf", "application/pdf")];
    expect(attachmentSummary("claude", files)[0]!.disposition).toBe("ignored");
    expect(attachmentSummary("codex", files)[0]!.disposition).toBe("path");
    expect(attachmentSummary("acp:cursor", files)[0]!.disposition).toBe("link");
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
