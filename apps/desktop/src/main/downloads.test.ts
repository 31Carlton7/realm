import { describe, expect, it, vi } from "vitest";
import { DOWNLOAD_MAX_BYTES } from "@realm/contracts";
import { BlockedDownloads, DownloadGovernor, decideDownload, retryBlockedDownload, type DownloadGrant, type DownloadItemLike } from "./downloads";

/**
 * Plan 23's named mutants. Each is a one-line change to `downloads.ts` that one of these must catch:
 *
 *   1. a path escape via a page-authored filename;
 *   2. a file-type test creeping back into the gate, refusing what the user asked for;
 *   3. a grant outliving its op (a later page-initiated download riding it);
 *   4. the size cap read from `getTotalBytes()` instead of received bytes;
 *   5. origin drift between approval and download;
 *   6. DEFAULT-DENY regressed — the assertion the whole plan rests on.
 */

const NOW = 1_000_000;
const grant = (over: Partial<DownloadGrant> = {}): DownloadGrant =>
  ({ origin: "https://example.com", dir: "/tmp/proj/downloads", expiresAt: NOW + 30_000, ...over });

describe("decideDownload — the gate", () => {
  it("MUTANT 6: no grant is a refusal, always — this is the resting state", () => {
    expect(decideDownload({ grant: null, url: "https://example.com/a.pdf", filename: "a.pdf", now: NOW }))
      .toEqual({ allow: false, refused: "download_blocked" });
  });

  it("allows a document from the granted origin", () => {
    expect(decideDownload({ grant: grant(), url: "https://example.com/x/week-3.pdf", filename: "week-3.pdf", now: NOW }))
      .toEqual({ allow: true, name: "week-3.pdf" });
  });

  it("MUTANT 3: an expired grant refuses (a grant cannot be banked)", () => {
    expect(decideDownload({ grant: grant({ expiresAt: NOW }), url: "https://example.com/a.pdf", filename: "a.pdf", now: NOW }))
      .toEqual({ allow: false, refused: "download_blocked" });
  });

  it("MUTANT 5: origin drift between approval and download is refused", () => {
    for (const url of ["https://cdn.example.com/a.pdf", "http://example.com/a.pdf", "https://examp1e.com/a.pdf", "https://example.com:8443/a.pdf"]) {
      expect(decideDownload({ grant: grant(), url, filename: "a.pdf", now: NOW }), url)
        .toEqual({ allow: false, refused: "origin_mismatch" });
    }
  });

  it("MUTANT 1: a path escape in the filename is flattened, never honored", () => {
    for (const filename of ["../../.ssh/authorized_keys.txt", "..\\..\\notes.pdf", "/etc/passwd.txt", "a/b/c.pdf"]) {
      const d = decideDownload({ grant: grant(), url: "https://example.com/x", filename, now: NOW });
      expect(d.allow, filename).toBe(true);
      // Whatever survives is a bare name: no separators, no traversal, nothing that leaves the dir.
      expect(d.allow && d.name).not.toMatch(/[/\\]/);
      expect(d.allow && d.name).not.toContain("..");
    }
  });

  it("MUTANT 2: a grant covers ANY file type — an executable, an unheard-of format, no extension at all", () => {
    // The allowlist is gone on purpose. What the user approved is what gets written, and the reason
    // that is safe has nothing to do with the name: no grant, no file (every test above this one).
    for (const filename of ["setup.dmg", "install.pkg", "run.command", "x.sh", "tool.jar", "app.exe",
      "archive.7z", "notebook.ipynb", "model.safetensors", "x.someformatinventedin2029", "README"]) {
      expect(decideDownload({ grant: grant(), url: "https://example.com/x", filename, now: NOW }), filename)
        .toEqual({ allow: true, name: filename });
    }
  });

  it("MUTANT 2: the name is passed through as written, case and all — no extension is read at all", () => {
    for (const filename of ["Lecture 3.PDF", "safe.command.pdf", "safe.pdf.command"]) {
      expect(decideDownload({ grant: grant(), url: "https://example.com/x", filename, now: NOW }), filename)
        .toEqual({ allow: true, name: filename });
    }
  });

  it("MUTANT 1: a name that is nothing but dots names a file, never a directory entry", () => {
    // The extension test used to refuse these on its way past; `safeAttachmentName` is now the only
    // thing between them and a path, so what it produces is asserted rather than assumed.
    const name = (filename: string) => {
      const d = decideDownload({ grant: grant(), url: "https://example.com/x", filename, now: NOW });
      expect(d.allow, filename).toBe(true);
      return d.allow ? d.name : "";
    };
    expect(name(".")).toBe("download");
    expect(name("..")).toBe("download");
    expect(name("....")).toBe("download");
    expect(name(".bashrc")).toBe("bashrc"); // a dotfile loses the dot rather than being written as one
  });

  it("an opaque URL has no origin to match and is refused", () => {
    expect(decideDownload({ grant: grant(), url: "blob:https://example.com/abc", filename: "a.pdf", now: NOW }).allow).toBe(false);
  });
});

/* ------------------------------------ the governor ------------------------------------ */

function fakeItem(over: Partial<{ filename: string; url: string; received: number }> = {}) {
  const state = { savePath: "", cancelled: false, received: over.received ?? 1024 };
  const handlers: { updated: (() => void)[]; done: ((s: string) => void)[] } = { updated: [], done: [] };
  const item: DownloadItemLike = {
    getFilename: () => over.filename ?? "week-3.pdf",
    getURL: () => over.url ?? "https://example.com/week-3.pdf",
    getReceivedBytes: () => state.received,
    setSavePath: (p) => { state.savePath = p; },
    cancel: () => { state.cancelled = true; },
    on: (_e, cb) => { handlers.updated.push(cb); },
    once: (_e, cb) => { handlers.done.push(cb); },
  };
  return {
    item, state,
    receive: (bytes: number) => { state.received = bytes; handlers.updated.forEach((h) => h()); },
    finish: (s = "completed") => handlers.done.forEach((h) => h(s)),
  };
}

function makeGovernor(existing: string[] = []) {
  const made: string[] = [];
  const governor = new DownloadGovernor({
    mkdirp: (dir) => { made.push(dir); },
    exists: (p) => existing.includes(p),
    now: () => NOW,
  });
  return { governor, made };
}

describe("DownloadGovernor", () => {
  it("arms, clicks, writes into the granted directory, and reports a project-relative path", async () => {
    const { governor, made } = makeGovernor();
    const f = fakeItem();
    const run = governor.run("b1", grant(), async () => {
      expect(governor.handle("b1", f.item)).toEqual({ allow: true, name: "week-3.pdf" });
      f.finish();
      return { ok: true };
    });

    expect(await run).toEqual({ ok: true, name: "week-3.pdf", bytes: 1024, relPath: "downloads/week-3.pdf" });
    expect(f.state.savePath).toBe("/tmp/proj/downloads/week-3.pdf");
    expect(made).toEqual(["/tmp/proj/downloads"]);
  });

  it("MUTANT 3: the grant is ONE-SHOT — a second download on the same click is cancelled", async () => {
    const { governor } = makeGovernor();
    const first = fakeItem();
    const second = fakeItem({ filename: "extra.pdf" });
    const run = governor.run("b1", grant(), async () => {
      expect(governor.handle("b1", first.item).allow).toBe(true);
      expect(governor.handle("b1", second.item)).toEqual({ allow: false, refused: "download_blocked" });
      first.finish();
      return { ok: true };
    });
    await run;
    expect(second.state.savePath).toBe("");
  });

  it("MUTANT 3: the grant does not outlive its op — a later download finds nothing armed", async () => {
    const { governor } = makeGovernor();
    const during = fakeItem();
    await governor.run("b1", grant(), async () => { governor.handle("b1", during.item); during.finish(); return { ok: true }; });

    const after = fakeItem({ filename: "late.pdf" });
    expect(governor.handle("b1", after.item)).toEqual({ allow: false, refused: "download_blocked" });
    expect(after.state.savePath).toBe("");
  });

  it("MUTANT 4: the cap is enforced on RECEIVED bytes, so a chunked response cannot lie past it", async () => {
    const { governor } = makeGovernor();
    // `getTotalBytes()` is deliberately absent from `DownloadItemLike` — there is no way to read it,
    // which is stronger than remembering not to.
    const f = fakeItem();
    const result = await governor.run("b1", grant(), async () => {
      governor.handle("b1", f.item);
      f.receive(DOWNLOAD_MAX_BYTES + 1);
      return { ok: true };
    });

    expect(f.state.cancelled).toBe(true);
    expect(result).toMatchObject({ ok: false, refused: "too_large" });
  });

  it("a download that stays under the cap is not cancelled", async () => {
    const { governor } = makeGovernor();
    const f = fakeItem();
    const result = await governor.run("b1", grant(), async () => {
      governor.handle("b1", f.item);
      f.receive(DOWNLOAD_MAX_BYTES - 1);
      f.finish();
      return { ok: true };
    });
    expect(f.state.cancelled).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("MUTANT 1: a colliding name suffixes rather than overwriting", async () => {
    const { governor } = makeGovernor(["/tmp/proj/downloads/week-3.pdf"]);
    const f = fakeItem();
    await governor.run("b1", grant(), async () => { governor.handle("b1", f.item); f.finish(); return { ok: true }; });
    expect(f.state.savePath).toBe("/tmp/proj/downloads/week-3 (2).pdf");
  });

  it("an interrupted download is an honest failure, not a hang", async () => {
    const { governor } = makeGovernor();
    const f = fakeItem();
    const result = await governor.run("b1", grant(), async () => { governor.handle("b1", f.item); f.finish("interrupted"); return { ok: true }; });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain("did not finish");
  });

  it("a click that starts NO download resolves at the grant's TTL rather than hanging forever", async () => {
    vi.useFakeTimers();
    try {
      const governor = new DownloadGovernor({ mkdirp: () => {}, exists: () => false, now: () => Date.now() });
      const run = governor.run("b1", { origin: "https://example.com", dir: "/tmp/d", expiresAt: Date.now() + 1000 }, async () => ({ ok: true }));
      await vi.advanceTimersByTimeAsync(1100);
      const result = await run;
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain("did not start a download");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed click never leaves a pane armed", async () => {
    const { governor } = makeGovernor();
    const result = await governor.run("b1", grant(), async () => ({ ok: false, error: "ref=7 has no visible geometry" }));
    expect(result).toMatchObject({ ok: false });

    const late = fakeItem();
    expect(governor.handle("b1", late.item)).toEqual({ allow: false, refused: "download_blocked" });
  });

  it("refuses a second concurrent download on the same pane rather than racing two grants", async () => {
    const { governor } = makeGovernor();
    const f = fakeItem();
    const inner: { ok: boolean }[] = [];
    await governor.run("b1", grant(), async () => {
      inner.push(await governor.run("b1", grant(), async () => ({ ok: true })));
      governor.handle("b1", f.item);
      f.finish();
      return { ok: true };
    });
    expect(inner[0]).toMatchObject({ ok: false });
  });

  it("an unknown browser id (no wc→browser mapping) is refused", () => {
    const { governor } = makeGovernor();
    const f = fakeItem();
    expect(governor.handle(null, f.item)).toEqual({ allow: false, refused: "download_blocked" });
    expect(f.state.savePath).toBe("");
  });
});

/* --------------------------- W4: the user's own downloads --------------------------- */

/**
 * The point of W4 is that a blocked download stops being SILENT. Its mutants:
 *   - the page-authored filename reaching the bar unsanitized;
 *   - the retry bypassing the governor (writing without a grant);
 *   - an entry surviving its take, so one approval fetches twice.
 */
describe("BlockedDownloads", () => {
  const clock = { now: NOW };
  const make = () => new BlockedDownloads(() => clock.now);

  it("remembers a blocked download and offers it, with a sanitized name", () => {
    const b = make();
    const entry = b.note("b1", "https://example.com/x", "../../week 3.pdf")!;
    expect(entry.name).toBe("week 3.pdf");
    // The URL never crosses into what the renderer is handed.
    expect(Object.keys(entry).sort()).toEqual(["id", "name", "ts"]);
  });

  it("offers every type it remembers — there is no longer a shown-but-unofferable class", () => {
    const b = make();
    for (const name of ["installer.dmg", "run.command", "notes"]) {
      expect(b.note("b1", "https://example.com/x", name)!.name, name).toBe(name);
    }
    expect(b.list("b1")).toHaveLength(3);
  });

  it("says nothing about an item with no address to re-request", () => {
    const b = make();
    expect(b.note("b1", "blob:https://example.com/abc", "x.pdf")).toBeNull();
    expect(b.list("b1")).toEqual([]);
  });

  it("keeps entries per pane, newest last, capped", () => {
    const b = make();
    for (let i = 0; i < 8; i++) b.note("b1", "https://example.com/x", `f${i}.pdf`);
    b.note("b2", "https://example.com/x", "other.pdf");
    const list = b.list("b1");
    expect(list).toHaveLength(5);
    expect(list[list.length - 1]!.name).toBe("f7.pdf");
    expect(b.list("b2")).toHaveLength(1);
  });

  it("expires: the bar is about the click just made, not a history of the session", () => {
    const b = make();
    b.note("b1", "https://example.com/x", "old.pdf");
    clock.now = NOW + 6 * 60_000;
    expect(b.list("b1")).toEqual([]);
    clock.now = NOW;
  });

  it("ignores a download with no real origin — nothing meaningful to name or re-fetch", () => {
    expect(make().note("b1", "data:text/plain,hi", "x.pdf")).toBeNull();
  });

  it("take removes as it takes, so one approval cannot fetch twice", () => {
    const b = make();
    const entry = b.note("b1", "https://example.com/x", "a.pdf")!;
    expect(b.take("b1", entry.id)).not.toBeNull();
    expect(b.take("b1", entry.id)).toBeNull();
    expect(b.list("b1")).toEqual([]);
  });

  it("dismiss and release drop entries", () => {
    const b = make();
    const e = b.note("b1", "https://example.com/x", "a.pdf")!;
    b.note("b1", "https://example.com/x", "b.pdf");
    b.dismiss("b1", e.id);
    expect(b.list("b1").map((x) => x.name)).toEqual(["b.pdf"]);
    b.release("b1");
    expect(b.list("b1")).toEqual([]);
  });
});

describe("retryBlockedDownload — the user's Save button", () => {
  it("goes through the SAME governor: a grant, then the file, into the same directory", async () => {
    const { governor, made } = makeGovernor();
    const blocked = new BlockedDownloads(() => NOW);
    const entry = blocked.note("b1", "https://example.com/week-3.pdf", "week-3.pdf")!;
    const f = fakeItem();
    const fetched: string[] = [];

    const result = await retryBlockedDownload(governor, blocked, {
      browserId: "b1", id: entry.id, dir: "/tmp/proj/downloads", now: () => NOW,
      downloadURL: (url) => {
        fetched.push(url);
        // What `webContents.downloadURL` causes: will-download fires again, now with a grant.
        governor.handle("b1", f.item);
        f.finish();
      },
    });

    expect(fetched).toEqual(["https://example.com/week-3.pdf"]);
    expect(result).toMatchObject({ ok: true, name: "week-3.pdf", relPath: "downloads/week-3.pdf" });
    expect(f.state.savePath).toBe("/tmp/proj/downloads/week-3.pdf");
    expect(made).toEqual(["/tmp/proj/downloads"]);
  });

  it("pins the grant to the BLOCKED item's origin, not the pane's current one", async () => {
    // The user is approving a file they can see by name; the pane may have navigated since.
    const { governor } = makeGovernor();
    const blocked = new BlockedDownloads(() => NOW);
    const entry = blocked.note("b1", "https://files.example.com/a.pdf", "a.pdf")!;
    const f = fakeItem({ url: "https://files.example.com/a.pdf", filename: "a.pdf" });

    const result = await retryBlockedDownload(governor, blocked, {
      browserId: "b1", id: entry.id, dir: "/tmp/d", now: () => NOW,
      downloadURL: () => { governor.handle("b1", f.item); f.finish(); },
    });
    expect(result.ok).toBe(true);
  });

  it("saves a type the allowlist used to refuse, because the user asked for it by name", async () => {
    const { governor } = makeGovernor();
    const blocked = new BlockedDownloads(() => NOW);
    const entry = blocked.note("b1", "https://example.com/x.dmg", "x.dmg")!;
    const f = fakeItem({ url: "https://example.com/x.dmg", filename: "x.dmg" });

    const result = await retryBlockedDownload(governor, blocked, {
      browserId: "b1", id: entry.id, dir: "/tmp/d", now: () => NOW,
      downloadURL: () => { governor.handle("b1", f.item); f.finish(); },
    });
    expect(result).toMatchObject({ ok: true, name: "x.dmg", relPath: "downloads/x.dmg" });
    expect(f.state.savePath).toBe("/tmp/d/x.dmg");
  });

  it("an entry that expired or was already saved fails honestly", async () => {
    const { governor } = makeGovernor();
    const result = await retryBlockedDownload(governor, new BlockedDownloads(() => NOW), {
      browserId: "b1", id: "gone", dir: "/tmp/d", now: () => NOW, downloadURL: () => {},
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain("no longer available");
  });

  it("a re-fetch that yields no download (a POST-only or one-time link) fails rather than hanging", async () => {
    vi.useFakeTimers();
    try {
      const governor = new DownloadGovernor({ mkdirp: () => {}, exists: () => false, now: () => Date.now() });
      const blocked = new BlockedDownloads(() => Date.now());
      const entry = blocked.note("b1", "https://example.com/one-time", "report.pdf")!;
      const run = retryBlockedDownload(governor, blocked, {
        browserId: "b1", id: entry.id, dir: "/tmp/d", now: () => Date.now(),
        downloadURL: () => { /* the server answers with a page, not a file */ },
      });
      await vi.advanceTimersByTimeAsync(31_000);
      const result = await run;
      expect(result.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
