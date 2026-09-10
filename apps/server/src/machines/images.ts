import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { statfs } from "node:fs";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const statfsAsync = promisify(statfs);

/**
 * Disk images, content-addressed (Plan 25 W5).
 *
 * `<realmHome>/machines/images/<sha256>.{qcow2,iso}` with a JSON sidecar. Content-addressed because
 * two machines from the same catalog entry are the same bytes, and a hash is the only name under
 * which that is automatically true — no reference counting, no "is this the one I downloaded".
 *
 * Not in the space's project folder, which is the deliberate opposite of `DOWNLOAD_DIRNAME`: a
 * download is the user's file and belongs where they can see it, while a 20 GB disk image is Realm's
 * infrastructure and inside a git checkout is a hazard.
 */

/** Every terminal state is a WORD. A spinner that simply stops is the failure this list exists to
 *  make impossible — each of these is a different thing for a person to do next. */
export const IMAGE_ERRORS = [
  "offline", "http_error", "checksum_mismatch", "disk_full", "cancelled", "resume_unsupported", "not_a_disk_image",
] as const;
export type ImageError = (typeof IMAGE_ERRORS)[number];

export class ImageError_ extends Error {
  constructor(readonly code: ImageError, message: string) { super(message); }
}

export type ImageProgress = { received: number; total: number | null };

export type ImageDeps = {
  /** `<realmHome>/machines/images`. */
  dir: string;
  fetch?: typeof globalThis.fetch;
  /** Test seam over `qemu-img info`, which is how an imported file's real format is learned. */
  probe?: (path: string) => Promise<{ format: string; backing: boolean } | null>;
  /** Free bytes on the volume the images live on. */
  freeBytes?: (dir: string) => Promise<number>;
};

export class ImageStore {
  constructor(private readonly d: ImageDeps) {}

  private path(sha: string, kind: "qcow2" | "iso"): string { return join(this.d.dir, `${sha}.${kind}`); }
  private sidecar(sha: string): string { return join(this.d.dir, `${sha}.json`); }
  private partial(sha: string, kind: "qcow2" | "iso"): string { return join(this.d.dir, `${sha}.${kind}.part`); }

  /** Everything on disk, with whatever the sidecar remembered about where it came from. */
  async list(): Promise<{ sha256: string; kind: "qcow2" | "iso"; bytes: number; name: string }[]> {
    await mkdir(this.d.dir, { recursive: true });
    const files = await readdir(this.d.dir).catch(() => [] as string[]);
    const out: { sha256: string; kind: "qcow2" | "iso"; bytes: number; name: string }[] = [];
    for (const f of files) {
      const m = /^([0-9a-f]{64})\.(qcow2|iso)$/.exec(f);
      if (!m) continue;
      const size = await stat(join(this.d.dir, f)).then((s) => s.size).catch(() => 0);
      const meta = await readFile(this.sidecar(m[1]!), "utf8").then((t) => JSON.parse(t) as { name?: string }).catch(() => ({} as { name?: string }));
      out.push({ sha256: m[1]!, kind: m[2] as "qcow2" | "iso", bytes: size, name: meta.name ?? m[1]!.slice(0, 12) });
    }
    return out;
  }

  async has(sha256: string, kind: "qcow2" | "iso"): Promise<boolean> {
    return stat(this.path(sha256, kind)).then(() => true).catch(() => false);
  }

  pathFor(sha256: string, kind: "qcow2" | "iso"): string { return this.path(sha256, kind); }

  /**
   * Fetch an image, resumably, and verify it TWICE.
   *
   * Twice is not belt and braces; the two passes cover different bytes. The streaming hash covers
   * what THIS run wrote and fails a fresh download as early as possible. The from-disk re-hash is
   * the only pass that covers bytes written by a PREVIOUS attempt — which is the whole point of
   * resuming, and the only way a half-download that was corrupted before the process restarted is
   * ever caught.
   */
  async download(opts: {
    sha256: string; kind: "qcow2" | "iso"; url: string; name: string; expectedBytes?: number;
    onProgress?: (p: ImageProgress) => void;
    signal?: AbortSignal;
  }): Promise<string> {
    const { sha256, kind, url } = opts;
    await mkdir(this.d.dir, { recursive: true });
    const final = this.path(sha256, kind);
    if (await this.has(sha256, kind)) return final;

    const part = this.partial(sha256, kind);
    let from = await stat(part).then((s) => s.size).catch(() => 0);

    // Checked BEFORE anything is written: a disk that fills mid-download leaves a part file, a
    // confusing error from deep inside a stream, and no room to clean up either.
    const need = (opts.expectedBytes ?? 0) - from;
    if (need > 0) {
      const free = await (this.d.freeBytes ?? defaultFreeBytes)(this.d.dir);
      if (free < need + 256 * 1024 * 1024) {
        throw new ImageError_("disk_full", `${human(need)} more is needed and this volume has ${human(free)} free.`);
      }
    }

    const doFetch = this.d.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(url, { headers: from > 0 ? { Range: `bytes=${from}-` } : {}, signal: opts.signal });
    } catch (e) {
      if (opts.signal?.aborted) throw new ImageError_("cancelled", "the download was cancelled");
      throw new ImageError_("offline", `could not reach ${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new ImageError_("http_error", `${new URL(url).host} answered ${res.status} ${res.statusText}`);

    /**
     * THE named trap. A server that ignores `Range` answers **200 with the whole body**, and
     * appending that to a partial file produces a corrupt image of exactly the right length —
     * the classic silent corruption, caught only by a hash that a naive implementation skips
     * because it "already downloaded this".
     */
    if (from > 0 && res.status !== 206) {
      await rm(part, { force: true });
      from = 0;
    }
    if (!res.body) throw new ImageError_("http_error", "the server sent no body");

    const total = (() => {
      const len = Number(res.headers.get("content-length") ?? "");
      return Number.isFinite(len) && len > 0 ? len + from : opts.expectedBytes ?? null;
    })();

    // The streaming hash has to start from what is already on disk, or a resumed download hashes
    // only its own tail and every resume "fails" verification.
    const hash = createHash("sha256");
    if (from > 0) await pipeline(createReadStream(part), async function* (src) { for await (const c of src) hash.update(c as Buffer); });

    let received = from;
    const out = createWriteStream(part, { flags: from > 0 ? "a" : "w" });
    try {
      await pipeline(
        Readable.fromWeb(res.body as never),
        async function* (src) {
          for await (const chunk of src) {
            const buf = chunk as Buffer;
            hash.update(buf);
            received += buf.length;
            opts.onProgress?.({ received, total });
            yield buf;
          }
        },
        out,
      );
    } catch (e) {
      if (opts.signal?.aborted) throw new ImageError_("cancelled", "the download was cancelled");
      if (isDiskFull(e)) throw new ImageError_("disk_full", "the volume filled up while downloading");
      throw new ImageError_("offline", e instanceof Error ? e.message : String(e));
    }

    const streamed = hash.digest("hex");
    if (sha256 && streamed !== sha256) {
      // Removed rather than kept: a part file whose bytes are known to be wrong would be resumed
      // from forever, failing identically every time.
      await rm(part, { force: true });
      throw new ImageError_("checksum_mismatch", "the downloaded file does not match its published checksum, so it was discarded.");
    }
    // The from-disk pass — the only one that covers bytes a PREVIOUS attempt wrote.
    if (sha256) {
      const onDisk = await hashFile(part);
      if (onDisk !== sha256) {
        await rm(part, { force: true });
        throw new ImageError_("checksum_mismatch", "the file on disk does not match its published checksum, so it was discarded.");
      }
    }

    // Renamed only after verifying. The reverse — rename then verify — leaves a bad image under a
    // name that `has()` reports as present, and every later start uses it without asking again.
    await rename(part, final);
    await writeFile(this.sidecar(sha256), JSON.stringify({ name: opts.name, url, kind, bytes: received }, null, 2));
    return final;
  }

  /**
   * Adopt a file the user already has.
   *
   * Probed with `qemu-img info` and refused unless it is qcow2 or raw with NO backing chain — the
   * extension is never trusted. A backing chain is refused because it is a reference to another file
   * that Realm did not copy and cannot keep: the machine works until that file moves, and then fails
   * with an error about a path nobody remembers choosing.
   */
  async importFile(path: string, name: string): Promise<{ sha256: string; kind: "qcow2" | "iso" }> {
    const probe = this.d.probe ?? defaultProbe;
    const kind: "qcow2" | "iso" = path.toLowerCase().endsWith(".iso") ? "iso" : "qcow2";
    if (kind === "qcow2") {
      const info = await probe(path);
      if (!info) throw new ImageError_("not_a_disk_image", "Realm could not read that file as a disk image.");
      if (info.format !== "qcow2" && info.format !== "raw") {
        throw new ImageError_("not_a_disk_image", `that file is ${info.format}, and Realm can only boot qcow2 or raw images.`);
      }
      if (info.backing) {
        throw new ImageError_("not_a_disk_image", "that image has a backing file, so it is not self-contained — flatten it with `qemu-img convert` first.");
      }
    }
    await mkdir(this.d.dir, { recursive: true });
    const sha256 = await hashFile(path);
    const dest = this.path(sha256, kind);
    if (!(await this.has(sha256, kind))) {
      await pipeline(createReadStream(path), createWriteStream(dest));
    }
    await writeFile(this.sidecar(sha256), JSON.stringify({ name, url: null, kind, imported: path }, null, 2));
    return { sha256, kind };
  }

  async remove(sha256: string, kind: "qcow2" | "iso"): Promise<void> {
    await rm(this.path(sha256, kind), { force: true });
    await rm(this.sidecar(sha256), { force: true });
    await rm(this.partial(sha256, kind), { force: true });
  }
}

async function hashFile(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), async function* (src) { for await (const c of src) h.update(c as Buffer); });
  return h.digest("hex");
}

async function defaultFreeBytes(dir: string): Promise<number> {
  try {
    const s = await statfsAsync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return Number.MAX_SAFE_INTEGER; }
}

/** `qemu-img info --output=json`, which is the only thing that knows a file's real format. */
async function defaultProbe(path: string): Promise<{ format: string; backing: boolean } | null> {
  const { execFile } = await import("node:child_process");
  const { promisify: p } = await import("node:util");
  try {
    const { stdout } = await p(execFile)("qemu-img", ["info", "--output=json", path], { timeout: 10_000 });
    const info = JSON.parse(stdout) as { format?: string; "backing-filename"?: string };
    return { format: String(info.format ?? ""), backing: typeof info["backing-filename"] === "string" };
  } catch { return null; }
}

const isDiskFull = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOSPC";

export const human = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
};
