import { describe, expect, it } from "vitest";
import { isSealed, newSecretKey, open, seal, SECRET_KEY_BYTES } from "./secret-box";

/**
 * The mutants this format exists to kill:
 *   - domain separation dropped (a credential blob opening under the oauth key);
 *   - the AAD not actually bound, so a flipped domain byte still decrypts;
 *   - a tampered ciphertext decrypting to anything at all;
 *   - `open` throwing instead of returning null, which would turn a corrupt row into a crash on a
 *     read path (`readOauthState`) that is documented never to throw.
 */
describe("secret-box", () => {
  it("round-trips within a domain", () => {
    const key = newSecretKey();
    const blob = seal(key, "credential", "hunter2");
    expect(blob).not.toContain("hunter2");
    expect(open(key, "credential", blob)).toBe("hunter2");
  });

  it("a fresh IV per seal: the same plaintext under the same key never produces the same blob", () => {
    const key = newSecretKey();
    expect(seal(key, "oauth", "same")).not.toBe(seal(key, "oauth", "same"));
  });

  it("REFUSES a cross-domain open even with the right key (the named mutant: domain separation dropped)", () => {
    // The scenario this stands in for: a credential blob somehow reaching realm-server, which holds
    // the oauth key. It must not open — and here it does not even with the SAME key, so the guarantee
    // does not rest on the two keys having stayed apart.
    const key = newSecretKey();
    const credential = seal(key, "credential", "hunter2");
    expect(open(key, "oauth", credential)).toBeNull();
    expect(open(key, "credential", credential)).toBe("hunter2");
  });

  it("a flipped domain byte fails the tag, not just the header check (mutant: AAD not bound)", () => {
    const key = newSecretKey();
    const buf = Buffer.from(seal(key, "credential", "hunter2"), "base64");
    buf[1] = 1; // credential → oauth, header now claims a domain the AAD does not match
    expect(open(key, "oauth", buf.toString("base64"))).toBeNull();
  });

  it("the wrong key opens nothing", () => {
    const blob = seal(newSecretKey(), "credential", "hunter2");
    expect(open(newSecretKey(), "credential", blob)).toBeNull();
  });

  it("tampered ciphertext is refused rather than partially decoded", () => {
    const key = newSecretKey();
    const buf = Buffer.from(seal(key, "credential", "hunter2"), "base64");
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff;
    expect(open(key, "credential", buf.toString("base64"))).toBeNull();
  });

  it("returns null — never throws — for garbage, truncation and empties", () => {
    const key = newSecretKey();
    for (const bad of ["", "not base64 at all !!!", "AAAA", Buffer.alloc(10).toString("base64")]) {
      expect(() => open(key, "oauth", bad)).not.toThrow();
      expect(open(key, "oauth", bad)).toBeNull();
    }
  });

  it("rejects a key of the wrong length rather than deriving one", () => {
    expect(() => seal(Buffer.alloc(16), "oauth", "x")).toThrow();
    expect(open(Buffer.alloc(16), "oauth", seal(newSecretKey(), "oauth", "x"))).toBeNull();
    expect(newSecretKey()).toHaveLength(SECRET_KEY_BYTES);
  });

  it("isSealed tells a blob from the PLAINTEXT JSON older builds wrote — the no-migration path", () => {
    expect(isSealed(seal(newSecretKey(), "oauth", "{}"))).toBe(true);
    expect(isSealed('{"tokens":{"access_token":"t"}}')).toBe(false);
    expect(isSealed("")).toBe(false);
  });
});
