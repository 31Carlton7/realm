import { describe, expect, it } from "vitest";
import { EGG_KDF, type EggPack } from "@realm/contracts";
import { openPack, sealPack } from "./seal";
import { EGG_PACKS } from "./packs";

const PACK: EggPack = {
  group: "Test Group",
  labels: [{ present: "Asking Someone", past: "Asked Someone" }],
  greetings: ["hello"],
};

describe("sealing a pack", () => {
  it("round-trips under the right word", () => {
    const sealed = sealPack("open sesame", "t1", PACK);
    expect(openPack("open sesame", sealed)).toEqual(PACK);
  });

  it("is nothing at all under any other word", () => {
    /* THE unauthenticated mutant: AES without the GCM tag. A wrong key would then decrypt to
       plausible bytes and the JSON parse would be the only thing between a typo and a crash — and a
       blob that happened to parse would hand somebody a pack they were never given. */
    const sealed = sealPack("open sesame", "t1", PACK);
    for (const wrong of ["Open Sesame", "open sesame ", "opensesame", "", "1c3m"]) {
      expect(openPack(wrong, sealed), wrong).toBeNull();
    }
  });

  it("refuses a blob that has been edited, in any of its parts", () => {
    const sealed = sealPack("word", "t1", PACK);
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, "base64");
      buf[0] = buf[0]! ^ 0x01;
      return buf.toString("base64");
    };
    expect(openPack("word", { ...sealed, ct: flip(sealed.ct) })).toBeNull();
    expect(openPack("word", { ...sealed, iv: flip(sealed.iv) })).toBeNull();
    expect(openPack("word", { ...sealed, salt: flip(sealed.salt) })).toBeNull();
    expect(openPack("word", { ...sealed, ct: "not base64 at all" })).toBeNull();
  });

  it("refuses an edit that the JSON parse would happily accept", () => {
    /* What the GCM tag is actually FOR, and the only test that can show it. AES-GCM is a stream
       cipher, so byte N of the ciphertext is byte N of the plaintext: flipping one bit inside a
       string VALUE yields a document that still parses and still validates — one letter different.
       The parse is not integrity, and without the tag this returns a pack somebody else edited.
       THE mutant is `decipher.final()` dropped, or the tag never set. */
    const sealed = sealPack("word", "t1", PACK);
    const at = JSON.stringify(PACK).indexOf("Test Group") + 2; // inside the value, not on a quote
    const raw = Buffer.from(sealed.ct, "base64");
    raw[at] = raw[at]! ^ 0x20; // lower-cases a letter: still valid JSON, still a valid pack shape
    const opened = openPack("word", { ...sealed, ct: raw.toString("base64") });
    expect(opened).toBeNull();
  });

  it("gives two packs with the SAME word different ciphertext", () => {
    // Per-pack salt and IV. Reusing either would leak that two groups share a word, and reusing an
    // IV under one key is the classic way to lose a GCM stream outright.
    const a = sealPack("same", "a", PACK);
    const b = sealPack("same", "b", PACK);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    // …and both still open.
    expect(openPack("same", a)).toEqual(PACK);
    expect(openPack("same", b)).toEqual(PACK);
  });

  it("refuses a payload that is not a pack, rather than handing back whatever decrypted", () => {
    // The plaintext is validated after decryption: a blob from a newer build with a shape this one
    // does not understand is a locked pack, not a half-parsed one.
    const sealed = sealPack("word", "t1", { group: "g", labels: [{ present: "A", past: "B" }], greetings: [] });
    const bad = sealPack("word", "t1", { group: "", labels: [], greetings: [] } as unknown as EggPack);
    expect(openPack("word", sealed)).not.toBeNull();
    expect(openPack("word", bad)).toBeNull();
  });

  it("costs real time per guess, which is the only thing standing behind a short word", () => {
    /* THE cheap-KDF mutant: PBKDF2 with a low count, or a bare hash. The passphrases here are short
       words a friend can be told once, so the ONLY thing between the blob and an offline dictionary
       is what one attempt costs. This does not prove scrypt is configured correctly — it proves the
       cost was not quietly removed, which is the change a refactor makes. */
    expect(EGG_KDF.N).toBeGreaterThanOrEqual(1 << 16);
    expect(EGG_KDF.r).toBeGreaterThanOrEqual(8);
    const t0 = performance.now();
    openPack("definitely wrong", sealPack("right", "t", PACK));
    expect(performance.now() - t0).toBeGreaterThan(20);
  });
});

describe("the packs that ship", () => {
  it("carry no plaintext, which is the entire point of them", () => {
    /* The repository is public. THE mutant is a pack committed unsealed — or a `group` field left
       outside the ciphertext "so the settings row can show it", which would publish the group names
       one at a time. Every field here has to be opaque. */
    const raw = JSON.stringify(EGG_PACKS);
    expect(EGG_PACKS.length).toBeGreaterThan(0);
    for (const p of EGG_PACKS) {
      expect(Object.keys(p).sort()).toEqual(["ct", "id", "iv", "salt", "v"]);
      expect(p.id).toMatch(/^p\d+$/); // opaque: never the group's name, never the word
    }
    // Nothing in the file reads as English. A label or a greeting that leaked would show up as
    // letters-and-spaces; base64 of AES output does not contain a space at all.
    expect(raw).not.toMatch(/[A-Za-z]{3,} [A-Za-z]{3,}/);
  });

  it("each opens under exactly one word, and no pack opens under another's", () => {
    // Cross-checked without knowing any word: if two packs shared a key, the same blob would open
    // twice, and a friend handed one word would be handed somebody else's group with it.
    const ids = EGG_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const salts = EGG_PACKS.map((p) => p.salt);
    expect(new Set(salts).size).toBe(salts.length);
  });
});
