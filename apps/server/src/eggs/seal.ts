import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { EGG_KDF, EggPackSchema, type EggPack, type SealedEggPack } from "@realm/contracts";

/**
 * Sealing and opening a friend pack. The whole of the crypto, in one place, both directions.
 *
 * Both directions on purpose: a seal whose open lives somewhere else is a seal nobody tests against
 * its own output. `seal-egg-pack.mjs` — the authoring script Carlton runs — calls `sealPack`, and
 * the app only ever calls `openPack`; the round-trip test exercises the pair.
 *
 * `scrypt` rather than PBKDF2, and the reason is the passphrases: they are short words a friend can
 * be told once. PBKDF2 is cheap to parallelise on a GPU, which for a four-character word is the
 * difference between an afternoon and a second. scrypt's memory cost is what makes a guess actually
 * cost something. It is still not a secret against someone determined (see `egg-pack.ts`), and it
 * runs HERE rather than in the renderer because WebCrypto has no scrypt at all.
 */

const IV_BYTES = 12;
const SALT_BYTES = 16;
const TAG_BYTES = 16;

/** The key a passphrase and salt make. Node's default `maxmem` is 32 MB and these parameters want
 *  64, so it is raised deliberately rather than by lowering the cost. */
const keyFor = (passphrase: string, salt: Buffer): Buffer =>
  scryptSync(passphrase.normalize("NFKC"), salt, EGG_KDF.keyBytes,
    { N: EGG_KDF.N, r: EGG_KDF.r, p: EGG_KDF.p, maxmem: 256 * 1024 * 1024 });

export function sealPack(passphrase: string, id: string, pack: EggPack): SealedEggPack {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFor(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(pack), "utf8"), cipher.final()]);
  return {
    id, v: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ct: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
  };
}

/**
 * Open a pack, or null.
 *
 * Null covers every failure with no distinction between them, which is the point: a wrong
 * passphrase, a corrupted blob and a pack from a newer build all look identical from outside. The
 * GCM tag is what makes "wrong passphrase" detectable at all — without it a bad key would produce
 * plausible-looking bytes and the parse below would be the only thing standing between a typo and a
 * crash.
 */
export function openPack(passphrase: string, sealed: SealedEggPack): EggPack | null {
  try {
    const raw = Buffer.from(sealed.ct, "base64");
    if (raw.length <= TAG_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", keyFor(passphrase, Buffer.from(sealed.salt, "base64")), Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - TAG_BYTES)), decipher.final()]).toString("utf8");
    const parsed = EggPackSchema.safeParse(JSON.parse(plain));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
