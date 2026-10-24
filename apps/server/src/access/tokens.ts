import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CtlError } from "../ctl/errors";

/**
 * Access tokens: what a client on another machine offers to drive this server (`realm serve --listen`).
 *
 * The daemon's own token (`daemon.json`) is minted again on every boot and lives in one 0600 file, so
 * only a process that can read this home can use it. A client elsewhere cannot read that file and needs
 * a credential that outlives a restart, so these are made once, by name, and kept.
 *
 * Only a SHA-256 of each token is stored. The token itself is printed once, when it is made, and never
 * again: a copy of this home (a backup, a disk image) holds nothing that opens the listener. The tokens
 * are 256 random bits, so a fast hash is the right one — there is nothing to stretch.
 *
 * The file is written only by `realm token` on this machine, never by the server: a server holding a
 * stale copy and writing it back would resurrect a revoked token. So there is no RPC that makes or
 * removes one, and a client holding a token cannot mint itself a successor.
 */
export const ACCESS_TOKENS_FILE = "access-tokens.json";

/** Recognisable in a log or a paste, and never confused with the daemon token. */
export const TOKEN_PREFIX = "rlm_";

const StoredSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  name: z.string().min(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number().int(),
});
const FileSchema = z.object({ version: z.literal(1), tokens: z.array(StoredSchema) });
type Stored = z.infer<typeof StoredSchema>;

/** A token as `realm token list` shows it: never the token, never its hash. */
export type AccessToken = { id: string; name: string; createdAt: number };

export const accessTokensFile = (home: string): string => join(home, ACCESS_TOKENS_FILE);

const hashOf = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

/** Names are how a person tells their laptop's token from their phone's, and how they revoke one. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/**
 * Every stored token, or [] when there is no file yet. A file that is there but is not one Realm wrote
 * throws: read as "no tokens" it would quietly lock every client out, and written over it would lose
 * them, so the person is told and decides.
 */
function readStored(home: string): Stored[] {
  const file = accessTokensFile(home);
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  let data: unknown = null;
  try { data = JSON.parse(raw); } catch { /* judged below, like any other shape */ }
  const parsed = FileSchema.safeParse(data);
  if (!parsed.success) throw new CtlError("BAD_TOKENS_FILE", `${file} is not a token file Realm wrote; move it aside to start again`);
  return parsed.data.tokens;
}

function writeStored(home: string, tokens: Stored[]): void {
  mkdirSync(home, { recursive: true });
  const file = accessTokensFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

const shown = ({ id, name, createdAt }: Stored): AccessToken => ({ id, name, createdAt });

export function listTokens(home: string): AccessToken[] {
  return readStored(home).map(shown);
}

/** Makes a token. The returned `token` is the only copy there will ever be. */
export function createToken(home: string, name: string, now = Date.now()): AccessToken & { token: string } {
  const trimmed = name.trim();
  if (!NAME.test(trimmed)) throw new CtlError("USAGE", "a token's name is 1 to 64 letters, digits, spaces, dots, dashes or underscores");
  const tokens = readStored(home);
  if (tokens.some((t) => t.name === trimmed)) throw new CtlError("EXISTS", `there is already a token named ${trimmed}; revoke it first, or pick another name`);
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const stored: Stored = { id: randomBytes(6).toString("hex"), name: trimmed, hash: hashOf(token).toString("hex"), createdAt: now };
  writeStored(home, [...tokens, stored]);
  return { ...shown(stored), token };
}

/** Removes the token with this id or name. False when there is none. */
export function revokeToken(home: string, idOrName: string): boolean {
  const tokens = readStored(home);
  const left = tokens.filter((t) => t.id !== idOrName && t.name !== idOrName);
  if (left.length === tokens.length) return false;
  writeStored(home, left);
  return true;
}

/**
 * The server's view of the file: which token, if any, an offered value is. Re-read whenever the file
 * changes on disk, so a token made or revoked with `realm token` counts on the next handshake without
 * a restart — and `ids()` is how a revocation reaches clients already connected (`listenRemote`).
 */
export class AccessTokens {
  private cache: { stamp: string; tokens: Stored[] } | null = null;

  constructor(private readonly home: string, private readonly log: (line: string) => void = () => {}) {}

  /** Who `offered` is, or null. Every stored hash is compared, constant-time, whatever matched first. */
  verify(offered: string): AccessToken | null {
    if (!offered.startsWith(TOKEN_PREFIX)) return null;
    const want = hashOf(offered);
    let found: Stored | null = null;
    for (const t of this.current()) if (timingSafeEqual(Buffer.from(t.hash, "hex"), want)) found = t;
    return found ? shown(found) : null;
  }

  /** The ids of the tokens that are valid now. */
  ids(): Set<string> {
    return new Set(this.current().map((t) => t.id));
  }

  count(): number {
    return this.current().length;
  }

  private current(): Stored[] {
    let stamp: string;
    try {
      // Nanoseconds and the inode: every write is a new file renamed into place, so two writes in one
      // millisecond still read as two changes.
      const s = statSync(accessTokensFile(this.home), { bigint: true });
      stamp = `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    } catch {
      this.cache = { stamp: "absent", tokens: [] };
      return [];
    }
    if (this.cache?.stamp === stamp) return this.cache.tokens;
    let tokens: Stored[];
    try { tokens = readStored(this.home); } catch (e) {
      // Fail closed: a file nobody can read accepts nobody.
      this.log(`[access] ${e instanceof Error ? e.message : String(e)}; accepting no access tokens until it is fixed`);
      tokens = [];
    }
    this.cache = { stamp, tokens };
    return tokens;
  }
}
