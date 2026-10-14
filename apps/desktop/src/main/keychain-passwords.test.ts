import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keychainSource, keychainSourceFor, parseItem } from "./keychain-passwords";

const item = { server: "example.com", account: "ada", protocol: "https" as const, port: 0, path: "", label: "example.com", modified: 5 };

describe("keychainSource", () => {
  it("lists items, dropping what is not an http(s) item", async () => {
    const lines = [
      JSON.stringify(item),
      JSON.stringify({ ...item, protocol: "ftp" }),
      "not json",
      JSON.stringify({ ...item, server: "" }),
      JSON.stringify({ ...item, port: 99999, server: "b.example.com" }),
    ].join("\n");
    const src = keychainSource("/helper", { run: async () => ({ code: 0, stdout: lines }) });
    expect(await src.list()).toEqual([item, { ...item, server: "b.example.com", port: 0 }]);
  });

  it("reads one item by its attributes, scoped to the keychain it was given", async () => {
    const calls: string[][] = [];
    const src = keychainSource("/helper", { keychainPath: "/tmp/x.keychain-db", run: async (args) => { calls.push(args); return { code: 0, stdout: "pw" }; } });
    expect(await src.read({ ...item, port: 8443, path: "/login" })).toBe("pw");
    expect(calls[0]).toEqual(["read", "--server", "example.com", "--account", "ada", "--protocol", "https", "--port", "8443", "--path", "/login", "--keychain", "/tmp/x.keychain-db"]);
  });

  it("answers null for a refusal or nothing found, and throws for a list that failed", async () => {
    const src = keychainSource("/helper", { run: async () => ({ code: 4, stdout: "" }) });
    expect(await src.read(item)).toBeNull();
    await expect(src.list()).rejects.toThrow();
  });
});

describe("keychainSourceFor", () => {
  it("gives a harness the scratch keychain or none — never the login keychain", () => {
    // THE MUTANT: a live check that turns the keychain on reading the owner's login keychain.
    expect(keychainSourceFor({ helper: "/h", packaged: false, env: { REALM_ENABLE_FAKE_AGENT: "1" } })).toBeNull();
    expect(keychainSourceFor({ helper: "/h", packaged: false, env: { REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_KEYCHAIN: "/tmp/s" } })).not.toBeNull();
    expect(keychainSourceFor({ helper: null, packaged: true, env: {} })).toBeNull();
  });
});

describe("parseItem", () => {
  it("is null for anything malformed", () => {
    expect(parseItem("")).toBeNull();
    expect(parseItem(JSON.stringify({ ...item, account: 3 }))).toBeNull();
  });
});

/* The real helper against a scratch keychain made for this test and deleted after it — never the
   login keychain, which the helper is only ever pointed away from here by `--keychain`. Skipped where
   the helper is not built (not a Mac, or no swiftc). */
const helper = join(__dirname, "..", "..", "native", "bin", "realmkeychain");
describe.skipIf(process.platform !== "darwin" || !existsSync(helper))("the helper, on a scratch keychain", () => {
  it("lists metadata and reads one password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realm-kc-test-"));
    const kc = join(dir, "scratch.keychain-db");
    try {
      execFileSync("security", ["create-keychain", "-p", "scratch", kc]);
      execFileSync("security", ["unlock-keychain", "-p", "scratch", kc]);
      execFileSync("security", ["add-internet-password", "-a", "ada", "-s", "example.com", "-r", "htps", "-w", "scratch-secret", "-T", helper, kc]);
      const src = keychainSource(helper, { keychainPath: kc });
      const items = await src.list();
      expect(items.map((i) => [i.server, i.account, i.protocol])).toEqual([["example.com", "ada", "https"]]);
      expect(JSON.stringify(items)).not.toContain("scratch-secret");
      expect(await src.read(items[0]!)).toBe("scratch-secret");
      expect(await src.read({ ...items[0]!, account: "nobody" })).toBeNull();
    } finally {
      try { execFileSync("security", ["delete-keychain", kc]); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
