import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readHandedToken, tokenSha256 } from "./state";

describe("the app's token, handed over on stdin", () => {
  it("is the first line the app writes", async () => {
    const pipe = new PassThrough();
    const got = readHandedToken(pipe, 1_000);
    pipe.end("tok-abc\n");
    await expect(got).resolves.toBe("tok-abc");
  });

  it("is a failed boot when the app sends nothing, rather than a server nobody can drive", async () => {
    const empty = new PassThrough();
    const got = readHandedToken(empty, 1_000);
    empty.end();
    await expect(got).rejects.toThrow(/token/);
    await expect(readHandedToken(new PassThrough(), 50)).rejects.toThrow(/token/);
  });
});

describe("realm-server's boot", () => {
  const main = readFileSync(join(__dirname, "../main.ts"), "utf8");

  it("writes the CLI token to daemon.json and only a hash of the app's", () => {
    const writes = [...main.matchAll(/writeState\(home, \{([\s\S]*?)\}\);/g)].map((m) => m[1]!);
    expect(writes.length).toBeGreaterThan(0);
    for (const fields of writes) {
      if (fields.includes("...current")) continue;
      expect(fields).toMatch(/\btoken: cliToken\b/);
      expect(fields).toMatch(/appTokenSha256: tokenSha256\(appToken\)/);
      expect(fields).not.toMatch(/(^|[\s,{])token(,|\s*\}|$)/);
    }
  });

  it("drops the hand-over flag from the environment every agent and terminal inherits", () => {
    expect(main).toMatch(/delete process\.env\[APP_TOKEN_STDIN_ENV\];/);
    expect(main).not.toMatch(/process\.env\.[A-Z_]+\s*=\s*appToken/);
  });

  it("hashes with SHA-256, the way main compares a sealed copy", () => {
    expect(tokenSha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
