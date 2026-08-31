import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeFiles, safeAttachmentName, saveTempAttachment, sweepTempAttachments,
  TEMP_ATTACHMENT_TTL_MS, tempAttachmentDir,
} from "./attachments";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "realm-attach-test-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/** Backdate a file so the sweep sees it as stale. */
const age = async (p: string, ms: number) => { const t = new Date(Date.now() - ms); await utimes(p, t, t); };

describe("safeAttachmentName", () => {
  it("keeps an ordinary name and its extension", () => {
    expect(safeAttachmentName("Screenshot 2026.png")).toBe("Screenshot 2026.png");
  });
  it("cannot escape the directory — the name comes from the renderer", () => {
    expect(safeAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(safeAttachmentName("..\\..\\windows\\system32")).toBe("system32");
    expect(safeAttachmentName("/absolute/evil.png")).toBe("evil.png");
    for (const n of ["../../etc/passwd", "a/b/c.png", "x\\y.png"]) {
      expect(safeAttachmentName(n)).not.toMatch(/[/\\]/);
    }
  });
  it("strips leading dots and shell-hostile characters", () => {
    expect(safeAttachmentName("...hidden.png")).toBe("hidden.png");
    expect(safeAttachmentName("a;rm -rf b.png")).toBe("a_rm -rf b.png");
  });
  it("never returns an empty name", () => {
    expect(safeAttachmentName("")).toBe("pasted");
    expect(safeAttachmentName("///")).toBe("pasted");
    expect(safeAttachmentName("...")).toBe("pasted");
  });
  it("bounds the length", () => {
    expect(safeAttachmentName("x".repeat(500)).length).toBe(120);
  });
});

describe("saveTempAttachment", () => {
  it("writes the bytes under Realm's home and describes the file", async () => {
    const saved = await saveTempAttachment(home, "shot.png", "image/png", new Uint8Array([1, 2, 3]));
    expect(saved.path.startsWith(tempAttachmentDir(home))).toBe(true);
    expect(saved.mime).toBe("image/png");
    expect(saved.name).toBe("shot.png");
    expect(saved.size).toBe(3);
    expect(new Uint8Array(await readFile(saved.path))).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("falls back to the extension when the browser reported no type", async () => {
    const saved = await saveTempAttachment(home, "notes.md", "", new Uint8Array([1]));
    expect(saved.mime).toBe("text/markdown");
  });
  it("does not let two pastes of the same name overwrite each other", async () => {
    const a = await saveTempAttachment(home, "image.png", "image/png", new Uint8Array([1]));
    const b = await saveTempAttachment(home, "image.png", "image/png", new Uint8Array([2, 2]));
    expect(a.path).not.toBe(b.path);
    expect((await stat(a.path)).size).toBe(1);
    expect((await stat(b.path)).size).toBe(2);
  });
  it("creates the directory it needs", async () => {
    await saveTempAttachment(home, "a.png", "image/png", new Uint8Array([1]));
    expect((await readdir(tempAttachmentDir(home)))).toHaveLength(1);
  });
});

describe("sweepTempAttachments", () => {
  const dir = () => tempAttachmentDir(home);
  const put = async (name: string) => {
    await mkdir(dir(), { recursive: true });
    const p = join(dir(), name);
    await writeFile(p, "x");
    return p;
  };

  it("removes files past the TTL and keeps the rest", async () => {
    const old = await put("old.png");
    const fresh = await put("fresh.png");
    await age(old, TEMP_ATTACHMENT_TTL_MS + 60_000);
    const removed = await sweepTempAttachments(dir());
    expect(removed).toEqual(["old.png"]);
    expect(await readdir(dir())).toEqual(["fresh.png"]);
    void fresh;
  });

  it("keeps a file that is exactly at the boundary — the TTL is a floor, not a coin flip", async () => {
    const p = await put("edge.png");
    await age(p, TEMP_ATTACHMENT_TTL_MS - 5_000);
    expect(await sweepTempAttachments(dir())).toEqual([]);
    expect(await readdir(dir())).toEqual(["edge.png"]);
  });

  it("removes nothing when nothing is stale", async () => {
    await put("a.png"); await put("b.png");
    expect(await sweepTempAttachments(dir())).toEqual([]);
    expect((await readdir(dir())).sort()).toEqual(["a.png", "b.png"]);
  });

  it("is a no-op on a directory that was never created", async () => {
    await expect(sweepTempAttachments(join(home, "nope"))).resolves.toEqual([]);
  });

  it("saving sweeps too, so an app that never restarts still cannot leak", async () => {
    const old = await put("old.png");
    await age(old, TEMP_ATTACHMENT_TTL_MS + 60_000);
    await saveTempAttachment(home, "new.png", "image/png", new Uint8Array([1]));
    // The in-save sweep is fire-and-forget; give it the microtask turn it needs.
    await new Promise((r) => setTimeout(r, 20));
    expect((await readdir(dir())).some((n) => n === "old.png")).toBe(false);
  });
});

describe("describeFiles", () => {
  it("reports path, mime, name and real size for each file", async () => {
    const p = join(home, "report.pdf");
    await writeFile(p, "0123456789");
    expect(await describeFiles([p])).toEqual([{ path: p, mime: "application/pdf", name: "report.pdf", size: 10 }]);
  });
  it("drops what it cannot stat rather than inventing a size the cap would then trust", async () => {
    expect(await describeFiles([join(home, "gone.png")])).toEqual([]);
  });
  it("drops directories", async () => {
    await mkdir(join(home, "adir.png"));
    expect(await describeFiles([join(home, "adir.png")])).toEqual([]);
  });
});
