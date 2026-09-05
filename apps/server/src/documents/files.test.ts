import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { DOCUMENT_MAX_BYTES } from "@realm/contracts";
import { hashText, isTempArtifact, readDocument, readIfExists, writeAtomic, writeDocument } from "./files";

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
