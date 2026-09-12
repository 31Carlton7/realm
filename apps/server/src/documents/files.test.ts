import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { DOCUMENT_MAX_BYTES } from "@realm/contracts";
import { TEXT_SNIFF_BYTES, hashText, isTempArtifact, readDocument, readIfExists, textRefusal, writeAtomic, writeDocument } from "./files";

let dir: string;
const p = (name: string) => join(dir, name);
beforeEach(async () => { dir = tempDir("realm-docs-"); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("hashText", () => {
  it("is stable and distinguishes content", () => {
    expect(hashText("a")).toBe(hashText("a"));
    expect(hashText("a")).not.toBe(hashText("b"));
    // Whitespace-only differences must register — a trailing newline is a real edit.
    expect(hashText("a\n")).not.toBe(hashText("a"));
  });
});

describe("readDocument", () => {
  it("returns text and its hash", async () => {
    await writeFile(p("a.md"), "# Hi\n");
    expect(await readDocument(p("a.md"))).toEqual({ text: "# Hi\n", hash: hashText("# Hi\n") });
  });

  it("refuses a directory", async () => {
    await expect(readDocument(dir)).rejects.toThrow(/is a directory/);
  });

  it("refuses a file past the editable ceiling", async () => {
    await writeFile(p("big.md"), "x".repeat(DOCUMENT_MAX_BYTES + 1));
    await expect(readDocument(p("big.md"))).rejects.toThrow(/document pane opens up to/);
  });

  it("accepts a file exactly at the ceiling", async () => {
    await writeFile(p("edge.md"), "x".repeat(DOCUMENT_MAX_BYTES));
    await expect(readDocument(p("edge.md"))).resolves.toBeTruthy();
  });

  it("readIfExists answers null for a missing file but still throws real errors", async () => {
    expect(await readIfExists(p("nope.md"))).toBeNull();
    await expect(readIfExists(dir)).rejects.toThrow(/is a directory/);
  });
});

describe("writeAtomic", () => {
  it("writes the content and leaves no temp file behind", async () => {
    await writeAtomic(p("a.md"), "hello");
    expect(await readFile(p("a.md"), "utf8")).toBe("hello");
    expect(await readdir(dir)).toEqual(["a.md"]);
  });

  it("names temp files so the watcher can recognise them", () => {
    expect(isTempArtifact("/x/.realm-tmp-123-a.md")).toBe(true);
    expect(isTempArtifact("/x/a.md")).toBe(false);
  });
});

describe("writeDocument — the lost-update guard", () => {
  it("writes when disk still matches baseHash", async () => {
    await writeFile(p("a.md"), "v1");
    const r = await writeDocument(p("a.md"), "v2", hashText("v1"));
    expect(r).toEqual({ ok: true, hash: hashText("v2") });
    expect(await readFile(p("a.md"), "utf8")).toBe("v2");
  });

  /** The core case this whole plan exists to get right: the agent wrote while the user was typing. */
  it("refuses and returns the current text when disk moved underneath", async () => {
    await writeFile(p("a.md"), "agent's version");
    const r = await writeDocument(p("a.md"), "user's version", hashText("what the user opened"));
    expect(r).toEqual({ ok: false, currentText: "agent's version", currentHash: hashText("agent's version") });
    // The refusal must not have partially applied.
    expect(await readFile(p("a.md"), "utf8")).toBe("agent's version");
  });

  it("creates a new file when baseHash is null and nothing exists", async () => {
    const r = await writeDocument(p("new.md"), "fresh", null);
    expect(r.ok).toBe(true);
    expect(await readFile(p("new.md"), "utf8")).toBe("fresh");
  });

  it("refuses a first save onto a file something else already created", async () => {
    await writeFile(p("new.md"), "someone got here first");
    const r = await writeDocument(p("new.md"), "fresh", null);
    expect(r.ok).toBe(false);
    expect(await readFile(p("new.md"), "utf8")).toBe("someone got here first");
  });

  /** Deleted underneath an open editor: saving is how the user rescues their buffer, so this must
   *  re-create rather than refuse — refusing would strand the only copy of the text in the pane. */
  it("re-creates a file that was deleted underneath the editor", async () => {
    const r = await writeDocument(p("gone.md"), "rescued", hashText("what it used to be"));
    expect(r.ok).toBe(true);
    expect(await readFile(p("gone.md"), "utf8")).toBe("rescued");
  });

  it("treats an unchanged save as an ordinary write, not a conflict", async () => {
    await writeFile(p("a.md"), "same");
    const r = await writeDocument(p("a.md"), "same", hashText("same"));
    expect(r).toEqual({ ok: true, hash: hashText("same") });
  });
});

describe("textRefusal", () => {
  it("calls a NUL byte binary, the way git does", () => {
    expect(textRefusal(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]))).toBe("binary");
    expect(textRefusal(Buffer.from("const x = 1;\n", "utf8"))).toBeNull();
  });
  it("calls undecodable bytes not-utf8 rather than binary — it IS text, just not ours", () => {
    // "café au lait" in Latin-1: no NUL, but 0xE9 is not valid UTF-8. Opened as text it becomes
    // "caf\uFFFD" and the first save writes that back, losing the é for good.
    expect(textRefusal(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x61, 0x75]))).toBe("not-utf8");
  });
  it("catches a truncated character at the end of a file it read whole", () => {
    // Only the SNIFF boundary is allowed to cut a character in half. A short file that ends
    // mid-sequence is malformed, and stream mode applied unconditionally would wave it through.
    expect(textRefusal(Buffer.from([0x68, 0x69, 0xf0, 0x9f]))).toBe("not-utf8");
  });
  it("accepts a multi-byte character straddling the sniff boundary", () => {
    // The bug this prevents: a file with an emoji whose bytes span byte 8192 would be "binary" in
    // whichever quarter of cases the split lands mid-character.
    const head = Buffer.from("a".repeat(TEXT_SNIFF_BYTES - 2), "utf8");
    const bytes = Buffer.concat([head, Buffer.from("🙂", "utf8"), Buffer.from("tail", "utf8")]);
    expect(textRefusal(bytes)).toBeNull();
  });
  it("accepts an empty file", () => {
    expect(textRefusal(Buffer.alloc(0))).toBeNull();
  });
  it("looks only at the head — a text file with a blob in its middle still opens", () => {
    const bytes = Buffer.concat([Buffer.from("x".repeat(TEXT_SNIFF_BYTES), "utf8"), Buffer.from([0x00])]);
    expect(textRefusal(bytes)).toBeNull();
  });
});

describe("readDocument({ refuseBinary })", () => {
  it("refuses a binary file, naming it", async () => {
    await writeFile(p("logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
    await expect(readDocument(p("logo.png"), { refuseBinary: true })).rejects.toThrow(/logo\.png is a binary file/);
  });
  it("refuses a file it would rewrite on save, with a different sentence", async () => {
    await writeFile(p("latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await expect(readDocument(p("latin.txt"), { refuseBinary: true })).rejects.toThrow(/not UTF-8/);
  });
  it("still reads ordinary source", async () => {
    await writeFile(p("a.ts"), "export const x = 1;\n");
    expect((await readDocument(p("a.ts"), { refuseBinary: true })).text).toBe("export const x = 1;\n");
  });
  it("leaves the default path alone — a rename onto a PNG must still say EXISTS", async () => {
    // The reason the flag is opt-in: `renameDocument` asks `readIfExists` whether the target is
    // there, and "that file is binary" is not an answer to the question it asked.
    await writeFile(p("logo.png"), Buffer.from([0x89, 0x50, 0x00]));
    expect(await readIfExists(p("logo.png"))).not.toBeNull();
  });
});
