import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { symlink } from "node:fs/promises";
import { tempDir } from "@realm/test-utils";
import {
  describeFiles, fileThumbnail, openablePath, quickLookThumbnail, safeAttachmentName, saveTempAttachment,
  statFile, sweepTempAttachments, TEMP_ATTACHMENT_TTL_MS, tempAttachmentDir,
} from "./attachments";

let home: string;
beforeEach(async () => { home = tempDir("realm-attach-test-"); });
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
  it("describes a directory AS a directory, whatever its name looks like", async () => {
    // Dropped folders used to be discarded here and re-guessed in the renderer from the name alone,
    // which is how one arrived in the prompter wearing a generic document glyph. A folder called
    // `adir.png` is the case that proves the answer has to come from a stat: by extension it is an
    // image, and it is not.
    await mkdir(join(home, "adir.png"));
    expect(await describeFiles([join(home, "adir.png")]))
      .toEqual([{ path: join(home, "adir.png"), mime: "inode/directory", name: "adir.png", size: 0 }]);
  });
  it("still drops what is neither a file nor a directory", async () => {
    expect(await describeFiles([join(home, "nope")])).toEqual([]);
  });
});

/** A minimal, valid, one-page PDF. Written here rather than imported from the server's test-pdf
 *  helper so this suite stays inside apps/desktop — and QuickLook only needs a well-formed file, not
 *  an interesting one. */
function makePdf(): Buffer {
  const content = "BT /F1 18 Tf 72 720 Td (Hello Realm) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("quickLookThumbnail", () => {
  const darwin = process.platform === "darwin";
  const onDarwin = darwin ? it : it.skip;

  onDarwin("renders a PDF's first page — the case nativeImage cannot decode at all", async () => {
    const p = join(home, "report.pdf");
    await writeFile(p, makePdf());
    const url = await quickLookThumbnail(home, p, 96);
    expect(url).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  }, 20_000);

  onDarwin("answers null for a file QuickLook has no generator for, rather than throwing", async () => {
    const p = join(home, "mystery.zzz");
    await writeFile(p, "not a document");
    expect(await quickLookThumbnail(home, p, 96)).toBeNull();
  }, 20_000);

  onDarwin("answers null for a path that does not exist", async () => {
    expect(await quickLookThumbnail(home, join(home, "gone.pdf"), 96)).toBeNull();
  }, 20_000);

  onDarwin("leaves no scratch directory behind, on success or on failure", async () => {
    const p = join(home, "report.pdf");
    await writeFile(p, makePdf());
    await quickLookThumbnail(home, p, 96);
    await quickLookThumbnail(home, join(home, "gone.pdf"), 96);
    // `tmp/thumbs` may exist; what must never accumulate is a per-call directory inside it.
    let left: string[] = [];
    try { left = await readdir(join(home, "tmp", "thumbs")); } catch { /* never created is also fine */ }
    expect(left).toEqual([]);
  }, 20_000);

  it("is a no-op off macOS — qlmanage is Apple's, and the caller falls back to its glyph", async () => {
    if (darwin) return; // the darwin path is covered above; this is the guard's other branch
    expect(await quickLookThumbnail(home, join(home, "report.pdf"), 96)).toBeNull();
  });
});

/* What `files:stat` answers. The Library lists rows from an INDEX of what a session did, so a row
   whose file has since been deleted is ordinary rather than exceptional — and the preview draws its
   whole action set from this answer. */
describe("statFile", () => {
  it("describes a real file, resolved", async () => {
    const p = join(home, "report.md");
    await writeFile(p, "hello");
    const s = await statFile(join(home, "sub", "..", "report.md"));
    expect(s).toEqual({ path: p, size: 5, mtimeMs: expect.any(Number) });
  });

  it("answers null for a directory — a preview must not offer to save a copy of one", async () => {
    /* The mutant: drop `isFile()`. `stat` succeeds on a directory, so the preview would draw Save a
       copy, Reveal and Open over a folder, and `copyFile` would fail with EISDIR at the last step. */
    expect(await statFile(home)).toBeNull();
  });

  it("answers null for a path that is gone, and for one that is not absolute", async () => {
    expect(await statFile(join(home, "never.md"))).toBeNull();
    // The renderer's cwd is the app bundle, so a relative path resolves somewhere nobody asked about.
    expect(await statFile("report.md")).toBeNull();
    expect(await statFile(null)).toBeNull();
  });
});

describe("fileThumbnail", () => {
  it("never asks QuickLook about a type the mime table does not know", async () => {
    /* The mutant: drop the `isOpenablePath` guard. `qlmanage` answers "no generator" by HANGING
       until its timeout, so previewing a `.bin` would cost three seconds of a stalled child process
       — and the attachment tile, which shares this function, would pay it on every paste. This
       returning promptly, rather than what it returns, is the assertion. */
    const p = join(home, "mystery.zzz");
    await writeFile(p, "not a document");
    const started = Date.now();
    expect(await fileThumbnail(home, p, 96)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("answers null rather than throwing when there is no home to put scratch in", async () => {
    expect(await fileThumbnail(null, join(home, "report.pdf"), 96)).toBeNull();
    expect(await fileThumbnail(home, 42, 96)).toBeNull();
  });
});

/* The single gate on `attachment:open`, which is the one bridge call that hands a renderer-supplied
   path to `shell`. Everything a tile can open has to pass it. */
describe("openablePath", () => {
  const put = async (rel: string) => { const p = join(home, rel); await writeFile(p, "x"); return p; };

  it("resolves a document type Realm's mime table knows", async () => {
    const pdf = await put("report.pdf");
    expect(await openablePath(pdf)).toBe(pdf);
    expect(await openablePath(await put("notes.md"))).toBeTruthy();
    expect(await openablePath(await put("rows.csv"))).toBeTruthy();
  });

  it("refuses an extension the table does not know — which is what keeps `open` off an executable", async () => {
    // On macOS `open` RUNS a .app, a .command or a .tool rather than showing it. None of them is in
    // the mime table, so the table being the gate is what makes them unreachable.
    for (const name of ["run.command", "Thing.app", "helper.tool", "blob.bin", "noext"]) {
      expect(await openablePath(await put(name)), name).toBeNull();
    }
  });

  it("refuses a relative path, a non-string and a file that is not there", async () => {
    expect(await openablePath("report.pdf")).toBeNull();
    expect(await openablePath(42)).toBeNull();
    expect(await openablePath(null)).toBeNull();
    expect(await openablePath(join(home, "never-written.pdf"))).toBeNull();
  });

  it("refuses a directory that merely ends in a known extension", async () => {
    const dir = join(home, "bundle.pdf");
    await mkdir(dir);
    expect(await openablePath(dir)).toBeNull();
  });

  it("reads the extension off the collapsed path, and a symlink cannot lend its own to something else", async () => {
    await writeFile(join(home, "collapse.pdf"), "x");
    // `resolve` runs before the extension check, so the answer is the COLLAPSED path — which is what
    // proves the extension was read off the destination rather than off the last segment written.
    // (`join` would collapse this itself, so the `..` has to survive into the argument as a string.)
    expect(await openablePath(`${home}/sub/../collapse.pdf`)).toBe(join(home, "collapse.pdf"));
    await writeFile(join(home, "run.command"), "x");
    const link = join(home, "innocent.pdf");
    await symlink(join(home, "run.command"), link);
    // The link's name says pdf; realpath says otherwise, and the second check is what reads it.
    expect(await openablePath(link)).toBeNull();
  });

  it("follows a symlink that points at a real document — the target agrees with the name", async () => {
    await writeFile(join(home, "real.pdf"), "x");
    const link = join(home, "link.pdf");
    await symlink(join(home, "real.pdf"), link);
    // The LINK is returned, not the target: it is the path the user was shown.
    expect(await openablePath(link)).toBe(link);
  });
});
