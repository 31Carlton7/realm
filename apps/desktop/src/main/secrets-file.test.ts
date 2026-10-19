import * as fs from "node:fs";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { READ_RETRY_MS, readSecretsFile, setAsideSecretsFile, writeSecretsFile, type SecretsFs } from "./secrets-file";
import { SecretStore } from "./secret-store";

/**
 * The mutants:
 *   - writing in place, or renaming before the flush: a crash leaves half a file, or an empty one;
 *   - a momentary EBUSY/EACCES read as "no file", which starts an empty store over every sign-in;
 *   - a set-aside that lands on an earlier one, or uses a name Windows refuses.
 */

const home = () => tempDir("realm-secrets-file-");
const errno = (code: string) => Object.assign(new Error(code), { code });

describe("writeSecretsFile", () => {
  it("replaces the file whole, at 0600, and leaves nothing beside it", () => {
    const dir = home();
    const path = join(dir, "secrets.json");
    writeFileSync(path, "old");
    writeSecretsFile(path, "new");
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["secrets.json"]);
  });

  it("a crash between the write and the rename leaves the old file as it was", () => {
    const dir = home();
    const path = join(dir, "secrets.json");
    writeFileSync(path, "every saved sign-in");
    const calls: string[] = [];
    const crashing: SecretsFs = {
      ...fs,
      writeFileSync: ((...a: Parameters<typeof fs.writeFileSync>) => { calls.push("write"); return fs.writeFileSync(...a); }) as typeof fs.writeFileSync,
      fsyncSync: (fd) => { calls.push("fsync"); fs.fsyncSync(fd); },
      renameSync: () => { calls.push("rename"); throw new Error("power cut"); },
    };
    expect(() => writeSecretsFile(path, "half of a new one", crashing)).toThrow("power cut");
    // MUTANT: write straight to `path` and this reads "half of a new one" — or nothing at all.
    expect(readFileSync(path, "utf8")).toBe("every saved sign-in");
    // Flushed before the rename, or the rename can reach the disk before the bytes it names.
    expect(calls).toEqual(["write", "fsync", "rename"]);
  });
});

describe("readSecretsFile", () => {
  it("is null for a file that is not there", () => {
    expect(readSecretsFile(join(home(), "secrets.json"))).toBeNull();
  });

  it("tries a momentary refusal again rather than believing it", () => {
    const dir = home();
    const path = join(dir, "secrets.json");
    writeFileSync(path, "{}");
    let refusals = 2;
    const slept: number[] = [];
    const busy: SecretsFs = { ...fs, readFileSync: ((...a: Parameters<typeof fs.readFileSync>) => {
      if (refusals-- > 0) throw errno("EBUSY");
      return fs.readFileSync(...a);
    }) as typeof fs.readFileSync };
    expect(readSecretsFile(path, { fs: busy, sleep: (ms) => slept.push(ms) })).toBe("{}");
    expect(slept).toEqual(READ_RETRY_MS.slice(0, 2));
  });

  it("throws a refusal that lasts, and never answers it with 'no file'", () => {
    const slept: number[] = [];
    const denied: SecretsFs = { ...fs, readFileSync: (() => { throw errno("EACCES"); }) as typeof fs.readFileSync };
    // MUTANT: answer null here and the store starts empty and writes itself over every sign-in.
    expect(() => readSecretsFile("/realm/secrets.json", { fs: denied, sleep: (ms) => slept.push(ms) })).toThrow("EACCES");
    expect(slept).toEqual(READ_RETRY_MS);
  });

  it("does not wait on an error that is not going to pass", () => {
    const slept: number[] = [];
    const broken: SecretsFs = { ...fs, readFileSync: (() => { throw errno("EISDIR"); }) as typeof fs.readFileSync };
    expect(() => readSecretsFile("/realm/secrets.json", { fs: broken, sleep: (ms) => slept.push(ms) })).toThrow("EISDIR");
    expect(slept).toEqual([]);
  });
});

describe("setAsideSecretsFile", () => {
  it("moves the file beside itself under a name that says when, and never over an earlier one", () => {
    const dir = home();
    const path = join(dir, "secrets.json");
    const at = new Date("2026-10-19T03:58:12.345Z");
    writeFileSync(path, "first");
    const first = setAsideSecretsFile(path, at);
    expect(first).toBe(join(dir, "secrets.unreadable-2026-10-19T03-58-12-345Z.json"));
    writeFileSync(path, "second");
    const second = setAsideSecretsFile(path, at);
    expect(second).toBe(join(dir, "secrets.unreadable-2026-10-19T03-58-12-345Z-2.json"));
    expect(readFileSync(first, "utf8")).toBe("first");
    expect(readFileSync(second, "utf8")).toBe("second");
    expect(fs.existsSync(path)).toBe(false);
  });
});

describe("the store on a real disk", () => {
  /** A store wired to the real file the way main wires it, with safeStorage stood in for. */
  const storeAt = (path: string) => new SecretStore({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`kc:${s}`),
      decryptString: (b) => { const s = b.toString(); if (!s.startsWith("kc:")) throw new Error("not ours"); return s.slice(3); },
    },
    readFile: () => readSecretsFile(path),
    writeFile: (text) => writeSecretsFile(path, text),
    setAside: () => setAsideSecretsFile(path, new Date(1_760_000_000_000)),
    appendAudit: () => {}, promptPresence: async () => true,
    now: () => 1_760_000_000_000, newId: () => "c1", defaultProfileId: () => "p1",
  });

  it("keeps a file it cannot read aside, starts a new one, and says where the old one went", () => {
    const dir = home();
    const path = join(dir, "secrets.json");
    writeFileSync(path, "{ \"credentials\": [ … cut off");
    const store = storeAt(path);
    expect(store.listCredentials("p1")).toEqual([]);
    const aside = join(dir, "secrets.unreadable-2025-10-09T08-53-20-000Z.json");
    expect(readFileSync(aside, "utf8")).toBe("{ \"credentials\": [ … cut off");
    expect(store.unreadableNotice()).toEqual({ path: aside, at: 1_760_000_000_000 });
    // The new store on disk carries the notice, so a relaunch before Settings is opened still says so.
    expect(storeAt(path).unreadableNotice()).toEqual({ path: aside, at: 1_760_000_000_000 });
  });
});
