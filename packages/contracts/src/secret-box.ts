/**
 * The at-rest secret format Realm's two Node processes must agree on, byte for byte.
 *
 * This file is in `contracts` for the reason everything else here is: Electron main (which owns the
 * safeStorage-anchored keyring) and realm-server (which holds sealed OAuth blobs in `realm.db`)
 * compile separately and must not drift on a wire format. It is deliberately **not re-exported from
 * `index.ts`** — it imports `node:crypto`, and `index.ts` is pulled into the renderer's browser
 * bundle. Import it by path (`@realm/contracts/src/secret-box`) from Node contexts only.
 *
 * ## Layout
 *
 * One `Buffer`, base64'd for storage:
 *
 *     byte 0        format version (1)
 *     byte 1        domain code (see `SECRET_DOMAINS`)
 *     bytes 2..13   AES-GCM IV, 12 random bytes — fresh per seal, never reused
 *     bytes 14..29  AES-GCM auth tag, 16 bytes
 *     bytes 30..    ciphertext
 *
 * ## Domain separation is the point, not decoration
 *
 * The domain byte is also fed to GCM as **additional authenticated data**. That makes domain
 * confusion a cryptographic impossibility rather than a code-review promise: a blob sealed under
 * `credential` fails the tag check when opened as `oauth` even by a holder of both keys, and a
 * tampered domain byte fails it too (the AAD no longer matches). This matters because the two
 * domains have deliberately unequal reach — realm-server is handed the `oauth` key so
 * `readOauthState` can stay synchronous, while the `credential` key never leaves Electron main. If
 * a credential's ciphertext ever did reach the server, that asymmetry would be the only thing
 * standing between it and the model. This makes it two things.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/** Domain → the byte written into the header and mixed in as AAD. Codes are permanent: changing one
 *  makes every existing blob of that domain unopenable, which for credentials means silent data
 *  loss the user only discovers at a sign-in prompt. Add, never renumber. */
export const SECRET_DOMAINS = { oauth: 1, credential: 2 } as const;
export type SecretDomain = keyof typeof SECRET_DOMAINS;

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 2 + IV_LEN + TAG_LEN;

/** AES-256. `newSecretKey` mints these; they live sealed inside the keyring, never on disk raw. */
export const SECRET_KEY_BYTES = 32;

export function newSecretKey(): Buffer {
  return randomBytes(SECRET_KEY_BYTES);
}

/** Seal `plaintext` under `key` for `domain`. The result is safe to store anywhere the key is not. */
export function seal(key: Buffer, domain: SecretDomain, plaintext: string): string {
  if (key.length !== SECRET_KEY_BYTES) throw new Error(`secret key must be ${SECRET_KEY_BYTES} bytes`);
  const code = SECRET_DOMAINS[domain];
  const iv = randomBytes(IV_LEN);
  const aad = Buffer.from([VERSION, code]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([aad, iv, cipher.getAuthTag(), ct]).toString("base64");
}

/**
 * Open a blob that MUST be of `domain`. Returns null — never throws, never partially decodes — for
 * every failure there is: wrong key, wrong domain, truncation, tampering, garbage, a future format
 * version. Callers treat null as "this secret is gone", which for OAuth means the row degrades to
 * `unconfigured` (recovery: click Connect) and for a credential means the fill refuses.
 *
 * A null is deliberately indistinguishable across causes. Telling a caller *why* a blob would not
 * open is an oracle, and there is no caller here that could act differently on the answer.
 */
export function open(key: Buffer, domain: SecretDomain, blob: string): string | null {
  if (key.length !== SECRET_KEY_BYTES) return null;
  let buf: Buffer;
  try { buf = Buffer.from(blob, "base64"); } catch { return null; }
  if (buf.length < HEADER_LEN) return null;
  const aad = buf.subarray(0, 2);
  const expected = Buffer.from([VERSION, SECRET_DOMAINS[domain]]);
  // Checked up front so a wrong-domain blob is refused by this branch as well as by the tag; the
  // tag alone would suffice, but failing on the cheap comparison keeps the reason obvious to anyone
  // reading a stack trace, and `timingSafeEqual` costs nothing on two bytes.
  if (aad.length !== expected.length || !timingSafeEqual(aad, expected)) return null;
  const iv = buf.subarray(2, 2 + IV_LEN);
  const tag = buf.subarray(2 + IV_LEN, HEADER_LEN);
  const ct = buf.subarray(HEADER_LEN);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Whether a stored string even looks like this format. Lets a reader tell a sealed blob from the
 *  PLAINTEXT JSON older builds wrote into the same column, without trying (and failing) to open it. */
export function isSealed(blob: string): boolean {
  if (!blob || blob.startsWith("{")) return false;
  let buf: Buffer;
  try { buf = Buffer.from(blob, "base64"); } catch { return false; }
  return buf.length >= HEADER_LEN && buf[0] === VERSION && Object.values<number>(SECRET_DOMAINS).includes(buf[1]!);
}
