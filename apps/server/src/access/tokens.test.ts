import { describe, expect, it } from "vitest";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tempDir } from "@realm/test-utils";
import { AccessTokens, accessTokensFile, createToken, listTokens, revokeToken, TOKEN_PREFIX } from "./tokens";

describe("access tokens", () => {
  it("are printed once and stored only as a hash, in a 0600 file", () => {
    const home = tempDir("realm-tokens-");
    const made = createToken(home, "laptop", 1_000);
    expect(made.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(made.token.length).toBe(TOKEN_PREFIX.length + 43); // 32 random bytes, base64url
    const raw = readFileSync(accessTokensFile(home), "utf8");
    expect(raw).not.toContain(made.token);
    expect(raw).not.toContain(made.token.slice(TOKEN_PREFIX.length));
    expect(statSync(accessTokensFile(home)).mode & 0o777).toBe(0o600);
    expect(listTokens(home)).toEqual([{ id: made.id, name: "laptop", createdAt: 1_000 }]);
    expect(JSON.stringify(listTokens(home))).not.toMatch(/[0-9a-f]{64}/); // no hash in what is shown
  });

  it("accept the exact token and nothing near it", () => {
    const home = tempDir("realm-tokens-");
    const a = createToken(home, "laptop");
    const b = createToken(home, "phone shell");
    const tokens = new AccessTokens(home);
    expect(tokens.verify(a.token)).toEqual({ id: a.id, name: "laptop", createdAt: a.createdAt });
    expect(tokens.verify(b.token)?.id).toBe(b.id);
    expect(tokens.verify("")).toBeNull();
    expect(tokens.verify(TOKEN_PREFIX)).toBeNull();
    expect(tokens.verify(a.token.slice(0, -1))).toBeNull();
    expect(tokens.verify(`${a.token}x`)).toBeNull();
    expect(tokens.verify(a.token.slice(TOKEN_PREFIX.length))).toBeNull(); // the prefix is part of it
    // A different token's last character swapped in: the hash, not a prefix, is what is compared.
    expect(tokens.verify(a.token.slice(0, -1) + (a.token.endsWith("A") ? "B" : "A"))).toBeNull();
  });

  it("are refused the moment they are revoked, by id or by name, with no restart", () => {
    const home = tempDir("realm-tokens-");
    const a = createToken(home, "laptop");
    const b = createToken(home, "desktop");
    const tokens = new AccessTokens(home);
    expect(tokens.verify(a.token)).not.toBeNull();
    expect(revokeToken(home, a.id)).toBe(true);
    expect(tokens.verify(a.token)).toBeNull();
    expect(tokens.ids()).toEqual(new Set([b.id]));
    expect(revokeToken(home, "desktop")).toBe(true);
    expect(tokens.verify(b.token)).toBeNull();
    expect(revokeToken(home, "desktop")).toBe(false);
    // …and one made while the server runs counts on the next handshake.
    const c = createToken(home, "tablet");
    expect(tokens.verify(c.token)?.name).toBe("tablet");
  });

  it("refuse a duplicate or unprintable name", () => {
    const home = tempDir("realm-tokens-");
    createToken(home, "laptop");
    expect(() => createToken(home, "laptop")).toThrow(/already a token named laptop/);
    expect(() => createToken(home, "")).toThrow(/name/);
    expect(() => createToken(home, "bad\nname")).toThrow(/name/);
    expect(() => createToken(home, "x".repeat(65))).toThrow(/name/);
  });

  it("accept nobody, and overwrite nothing, when the file is not one Realm wrote", () => {
    const home = tempDir("realm-tokens-");
    const a = createToken(home, "laptop");
    const tokens = new AccessTokens(home);
    expect(tokens.verify(a.token)).not.toBeNull();
    writeFileSync(accessTokensFile(home), "{ not json");
    expect(tokens.verify(a.token)).toBeNull();
    expect(() => createToken(home, "another")).toThrow(/not a token file Realm wrote/);
    expect(readFileSync(accessTokensFile(home), "utf8")).toBe("{ not json");
  });

  it("accept nothing on a home that has no file", () => {
    const tokens = new AccessTokens(tempDir("realm-tokens-"));
    expect(tokens.verify(`${TOKEN_PREFIX}${"A".repeat(43)}`)).toBeNull();
    expect(tokens.count()).toBe(0);
  });
});
