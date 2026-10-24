import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CtlError } from "./errors";

/**
 * Saved remotes: a name for a server on another machine, with its URL, the access token made for this
 * client, and the certificate to trust when it is self-signed. `realm --server <name> ps` then needs
 * nothing on the command line that a shell history or `ps` would keep.
 *
 * They live with this machine's user, not in a Realm home (a laptop that only drives a server has
 * none): `$XDG_CONFIG_HOME/realm/remotes.json`, else `~/.config/realm/remotes.json`. The file holds
 * tokens, so it is 0600 in a 0700 folder — and, as ssh does with a key, one that other users can read
 * is refused rather than used.
 */
const ProfileSchema = z.object({
  name: z.string(),
  url: z.string(),
  token: z.string(),
  /** A PEM certificate to trust, for a server with a self-signed one. */
  ca: z.string().nullable(),
  allowPlaintext: z.boolean(),
});
export type Profile = z.infer<typeof ProfileSchema>;
const FileSchema = z.object({ version: z.literal(1), remotes: z.array(ProfileSchema) });

export function profilesFile(env: NodeJS.ProcessEnv, home = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "realm", "remotes.json");
}

/** A remote's name doubles as `--server`'s value, so it must never look like a URL. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function readProfiles(file: string): Profile[] {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
    throw new CtlError("INSECURE_FILE", `${file} holds access tokens and other users can read it; run \`chmod 600 ${file}\``);
  }
  let data: unknown = null;
  try { data = JSON.parse(raw); } catch { /* judged below */ }
  const parsed = FileSchema.safeParse(data);
  if (!parsed.success) throw new CtlError("BAD_REMOTES_FILE", `${file} is not a remotes file Realm wrote`);
  return parsed.data.remotes;
}

function writeProfiles(file: string, remotes: Profile[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, remotes }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Adds a remote, or replaces the one with that name. */
export function saveProfile(file: string, p: Profile): void {
  if (!NAME.test(p.name)) throw new CtlError("USAGE", "a remote's name is 1 to 64 letters, digits, dots, dashes or underscores");
  writeProfiles(file, [...readProfiles(file).filter((r) => r.name !== p.name), p]);
}

export function removeProfile(file: string, name: string): boolean {
  const all = readProfiles(file);
  const left = all.filter((r) => r.name !== name);
  if (left.length === all.length) return false;
  writeProfiles(file, left);
  return true;
}

export function findProfile(file: string, name: string): Profile | null {
  return readProfiles(file).find((r) => r.name === name) ?? null;
}
