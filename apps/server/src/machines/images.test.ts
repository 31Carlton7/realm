import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { ImageStore, ImageError_, human } from "./images";
import { CATALOG, CATALOG_ABSENT_NOTE } from "./catalog-data";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const BODY = Buffer.from("a disk image, as far as anything here is concerned".repeat(40));
const SHA = sha(BODY);

/** A server that honours Range, or does not — which is the trap. */
function fakeFetch(opts: { body?: Buffer; status?: number; ignoreRange?: boolean; fail?: string } = {}) {
  const body = opts.body ?? BODY;
  const seen: (string | null)[] = [];
  const fn = (async (_url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
    if (opts.fail) throw new Error(opts.fail);
    const range = init?.headers?.Range ?? null;
    seen.push(range);
    if (opts.status && opts.status >= 400) {
      return { ok: false, status: opts.status, statusText: "Nope", headers: new Headers(), body: null } as unknown as Response;
    }
    const from = !opts.ignoreRange && range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    const slice = body.subarray(from);
    return {
      ok: true,
      status: !opts.ignoreRange && range ? 206 : 200,
      statusText: "OK",
      headers: new Headers({ "content-length": String(slice.length) }),
      body: new Blob([new Uint8Array(slice)]).stream(),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fn, seen };
}

function store(over: Partial<ConstructorParameters<typeof ImageStore>[0]> = {}) {
  const dir = tempDir("realm-images-");
  mkdirSync(dir, { recursive: true });
  return { dir, make: (o: Partial<ConstructorParameters<typeof ImageStore>[0]> = {}) => new ImageStore({ dir, ...over, ...o }) };
}

describe("downloading an image", () => {
  it("verifies, then renames — never the other way round", async () => {
    const { dir, make } = store();
    const f = fakeFetch();
    const path = await make({ fetch: f.fn }).download({ sha256: SHA, kind: "qcow2", url: "https://example.com/x.qcow2", name: "Test" });
    expect(path).toBe(join(dir, `${SHA}.qcow2`));
    expect(readFileSync(path).equals(BODY)).toBe(true);
    // The sidecar remembers where it came from, so a list can show a name rather than a hash.
    expect(JSON.parse(readFileSync(join(dir, `${SHA}.json`), "utf8")).name).toBe("Test");
    expect(existsSync(join(dir, `${SHA}.qcow2.part`))).toBe(false);
  });

  /* Rename-then-verify leaves a BAD image under a name `has()` reports as present, and every later
     start uses it without asking again. */
  it("leaves nothing under the final name when the checksum is wrong", async () => {
    const { dir, make } = store();
    const f = fakeFetch();
    await expect(make({ fetch: f.fn }).download({ sha256: "f".repeat(64), kind: "qcow2", url: "https://example.com/x", name: "Bad" }))
      .rejects.toMatchObject({ code: "checksum_mismatch" });
    expect(existsSync(join(dir, `${"f".repeat(64)}.qcow2`))).toBe(false);
    // …and the part file goes too: bytes known to be wrong would be resumed from forever, failing
    // identically every time.
    expect(existsSync(join(dir, `${"f".repeat(64)}.qcow2.part`))).toBe(false);
  });

  it("resumes from what is already on disk, and hashes ALL of it", async () => {
    const { dir, make } = store();
    // Half a download, as a previous attempt would have left it.
    writeFileSync(join(dir, `${SHA}.qcow2.part`), BODY.subarray(0, 400));
    const f = fakeFetch();
    const path = await make({ fetch: f.fn }).download({ sha256: SHA, kind: "qcow2", url: "https://example.com/x", name: "Test" });
    expect(f.seen[0]).toBe("bytes=400-");
    // The streaming hash has to start from what was already there, or a resumed download hashes only
    // its own tail and every resume "fails" verification.
    expect(readFileSync(path).equals(BODY)).toBe(true);
  });

  /**
   * THE named trap, and the one worth the most.
   *
   * A server that ignores `Range` answers **200 with the whole body**. Appending that to a partial
   * file produces a corrupt image of exactly the right length — the classic silent corruption, and
   * one a naive implementation never notices because it "already downloaded this".
   */
  it("restarts when a server answers 200 to a Range request instead of appending", async () => {
    const { dir, make } = store();
    writeFileSync(join(dir, `${SHA}.qcow2.part`), BODY.subarray(0, 400));
    const f = fakeFetch({ ignoreRange: true });
    const path = await make({ fetch: f.fn }).download({ sha256: SHA, kind: "qcow2", url: "https://example.com/x", name: "Test" });
    expect(f.seen[0]).toBe("bytes=400-");
    // Truncated and restarted, so the file is the body exactly — not 400 bytes plus the body.
    expect(statSync(path).size).toBe(BODY.length);
    expect(readFileSync(path).equals(BODY)).toBe(true);
  });

  /**
   * The bug a demo found: an entry with no published checksum was named `<sha256>.<kind>` with an
   * EMPTY sha — a file called `.iso`. Hidden, meaningless, and shared by every unverified image, so
   * the second one fetched would silently be served the first one's bytes.
   *
   * The store's one invariant is that a file's name IS its content. An unverified entry keeps it by
   * being named after what ARRIVED, which says nothing about verification that is not true.
   */
  it("content-addresses an unverified image by what arrived, not by an empty hash", async () => {
    const { dir, make } = store();
    const path = await make({ fetch: fakeFetch().fn }).download({ sha256: "", kind: "iso", url: "https://example.com/a.iso", name: "Alpine" });
    expect(path).toBe(join(dir, `${SHA}.iso`));
    expect(existsSync(join(dir, ".iso")), "a hidden file named `.iso`").toBe(false);
    // …and the sidecar says it was not checked against anything, which is the honest record.
    expect(JSON.parse(readFileSync(join(dir, `${SHA}.json`), "utf8")).verified).toBe(false);
  });

  it("keeps two unverified images apart", async () => {
    const { dir, make } = store();
    const other = Buffer.from("a completely different image");
    await make({ fetch: fakeFetch().fn }).download({ sha256: "", kind: "iso", url: "https://example.com/a.iso", name: "A" });
    await make({ fetch: fakeFetch({ body: other }).fn }).download({ sha256: "", kind: "iso", url: "https://example.com/b.iso", name: "B" });
    // Under the old naming these were one file, and the second machine would have booted the first
    // machine's image with nothing anywhere saying so.
    expect(existsSync(join(dir, `${SHA}.iso`))).toBe(true);
    expect(existsSync(join(dir, `${sha(other)}.iso`))).toBe(true);
    expect(readFileSync(join(dir, `${sha(other)}.iso`)).equals(other)).toBe(true);
  });

  it("gives each unverified download its own part file, so two do not append to one", async () => {
    const { dir, make } = store();
    const s1 = make({ fetch: fakeFetch().fn });
    await s1.download({ sha256: "", kind: "iso", url: "https://example.com/a.iso", name: "A" });
    // The part file is keyed on the URL rather than on the (absent) hash — two unverified downloads
    // sharing `.iso.part` would interleave into one corrupt file.
    expect(readFileSync(join(dir, `${SHA}.iso`)).equals(BODY)).toBe(true);
  });

  it("skips the work entirely when the image is already there", async () => {
    const { dir, make } = store();
    writeFileSync(join(dir, `${SHA}.qcow2`), BODY);
    const f = fakeFetch();
    await make({ fetch: f.fn }).download({ sha256: SHA, kind: "qcow2", url: "https://example.com/x", name: "Test" });
    expect(f.seen).toEqual([]);
  });

  it("reports progress against a real total", async () => {
    const { make } = store();
    const seen: { received: number; total: number | null }[] = [];
    await make({ fetch: fakeFetch().fn }).download({ sha256: SHA, kind: "qcow2", url: "https://example.com/x", name: "T", onProgress: (p) => seen.push(p) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]!.received).toBe(BODY.length);
    expect(seen[seen.length - 1]!.total).toBe(BODY.length);
  });

  /* Every terminal state is a WORD. A spinner that simply stops is what this list exists to make
     impossible — each of these is a different thing for a person to do next. */
  it("names each failure rather than stopping", async () => {
    const { make } = store();
    await expect(make({ fetch: fakeFetch({ fail: "getaddrinfo ENOTFOUND" }).fn })
      .download({ sha256: SHA, kind: "qcow2", url: "https://example.com/x", name: "T" }))
      .rejects.toMatchObject({ code: "offline" });
    await expect(make({ fetch: fakeFetch({ status: 404 }).fn })
      .download({ sha256: SHA, kind: "qcow2", url: "https://example.com/x", name: "T" }))
      .rejects.toMatchObject({ code: "http_error" });
    await expect(make({ fetch: fakeFetch().fn, freeBytes: async () => 1024 })
      .download({ sha256: SHA, kind: "qcow2", url: "https://example.com/x", name: "T", expectedBytes: 10 * 1024 ** 3 }))
      .rejects.toMatchObject({ code: "disk_full" });
  });

  /* Checked BEFORE anything is written: a disk that fills mid-download leaves a part file, an error
     from deep inside a stream, and no room to clean up either. */
  it("checks for room before it writes a byte", async () => {
    const { dir, make } = store();
    await expect(make({ fetch: fakeFetch().fn, freeBytes: async () => 1024 })
      .download({ sha256: SHA, kind: "qcow2", url: "https://example.com/x", name: "T", expectedBytes: 10 * 1024 ** 3 }))
      .rejects.toBeInstanceOf(ImageError_);
    expect(existsSync(join(dir, `${SHA}.qcow2.part`))).toBe(false);
  });
});

describe("importing a file the user already has", () => {
  it("takes qcow2 and raw, and refuses anything else by its REAL format", async () => {
    const { dir, make } = store();
    const src = join(dir, "mine.qcow2");
    writeFileSync(src, BODY);
    // The extension is never trusted: this file is named .qcow2 and the probe is what decides.
    const ok = await make({ probe: async () => ({ format: "qcow2", backing: false }) }).importFile(src, "Mine");
    expect(ok.sha256).toBe(SHA);
    expect(existsSync(join(dir, `${SHA}.qcow2`))).toBe(true);

    await expect(make({ probe: async () => ({ format: "vmdk", backing: false }) }).importFile(src, "Mine"))
      .rejects.toMatchObject({ code: "not_a_disk_image" });
    await expect(make({ probe: async () => null }).importFile(src, "Mine"))
      .rejects.toMatchObject({ code: "not_a_disk_image" });
  });

  /* A backing chain is a reference to another file Realm did not copy and cannot keep. The machine
     works until that file moves, and then fails with an error about a path nobody remembers. */
  it("refuses an image that is not self-contained, and says how to flatten it", async () => {
    const { dir, make } = store();
    const src = join(dir, "layered.qcow2");
    writeFileSync(src, BODY);
    await expect(make({ probe: async () => ({ format: "qcow2", backing: true }) }).importFile(src, "Layered"))
      .rejects.toThrow(/qemu-img convert/);
  });

  it("does not probe an ISO, which is not a disk image format at all", async () => {
    const { dir, make } = store();
    const src = join(dir, "installer.iso");
    writeFileSync(src, BODY);
    let probed = false;
    const r = await make({ probe: async () => { probed = true; return null; } }).importFile(src, "Installer");
    expect(probed).toBe(false);
    expect(r.kind).toBe("iso");
  });
});

describe("the catalog", () => {
  /**
   * Pinned in the repo, and the reason is the checksum: one fetched over the same channel as the
   * image verifies nothing at all, since whoever could substitute the image could substitute the
   * hash beside it. Pinning makes the RELEASE the trust anchor.
   */
  it("carries whole entries rather than a feed URL", () => {
    expect(CATALOG.length).toBeGreaterThan(2);
    for (const e of CATALOG) {
      expect(e.url, e.id).toMatch(/^https:\/\//);
      expect(e.memoryMb, e.id).toBeGreaterThan(0);
      expect(e.diskGb, e.id).toBeGreaterThan(0);
      expect(["disk", "iso"], e.id).toContain(e.kind);
    }
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(CATALOG.length);
  });

  /**
   * An entry with no hash is offered as an IMPORT rather than a download, and the empty string is
   * how it says so. Publishing a hash nobody verified would be worse than publishing none: it would
   * look like a guarantee. Filling these in is a release-time job with the image in hand.
   */
  it("says nothing it has not verified", () => {
    for (const e of CATALOG) {
      expect(e.sha256 === "" || /^[0-9a-f]{64}$/.test(e.sha256), `${e.id}: ${e.sha256}`).toBe(true);
    }
  });

  /* An entry that downloaded something and then could not install it would be worse than not
     offering it, so the two impossible guests are a NOTE rather than a catalog row. */
  it("says why Windows and macOS are absent rather than offering them", () => {
    expect(CATALOG.map((e) => e.id.toLowerCase()).join(" ")).not.toMatch(/windows|macos/);
    expect(CATALOG_ABSENT_NOTE).toContain("Windows");
    expect(CATALOG_ABSENT_NOTE).toContain("macOS");
  });
});

describe("sizes a person reads", () => {
  it("uses the unit the number belongs in", () => {
    expect(human(600 * 1024 ** 2)).toBe("600 MB");
    expect(human(2.6 * 1024 ** 3)).toBe("2.6 GB");
    expect(human(40 * 1024)).toBe("40 KB");
  });
});
