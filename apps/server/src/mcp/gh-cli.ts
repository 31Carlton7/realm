import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** What asking the GitHub CLI for its token came to. The token itself never leaves realm-server. */
export type GhToken = { ok: true; token: string } | { ok: false; reason: "missing" | "signed-out" };

/** Runs `gh` with these arguments and resolves its stdout, or rejects when it exits non-zero. */
export type GhRun = (bin: string, args: string[]) => Promise<string>;

/**
 * Where `gh` lives: `REALM_GH` when set, else PATH first, so a gh someone chose to put ahead of the others is the one asked, then
 * the usual install locations by name — a Mac app launched from the Dock gets launchd's PATH, which
 * has no Homebrew in it.
 */
export function ghCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  // A gh named outright wins, alone: one installed somewhere none of these reach, or a live check's
  // stand-in, which PATH cannot carry because main puts the login shell's PATH first.
  if (env.REALM_GH) return [env.REALM_GH];
  const exe = process.platform === "win32" ? "gh.exe" : "gh";
  const known = process.platform === "win32"
    ? [join(env.ProgramFiles ?? "C:\\Program Files", "GitHub CLI", exe)]
    : ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", join(homedir(), ".local/bin/gh"), "/home/linuxbrew/.linuxbrew/bin/gh"];
  const onPath = (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, exe));
  return [...new Set([...onPath, ...known])];
}

const runGh: GhRun = (bin, args) => new Promise((resolve, reject) => {
  // GH_PROMPT_DISABLED: a signed-out gh must say so and exit, never wait on a prompt nobody can see.
  execFile(bin, args, { timeout: 10_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (err, stdout) => {
    if (err) reject(err); else resolve(stdout);
  });
});

/**
 * The token of the GitHub CLI's existing sign-in for github.com, read with `gh auth token`. That is
 * the same token `gh` itself sends, from the keyring or its config — Realm stores its own copy sealed
 * with the row's OAuth state and asks again when the server stops accepting it.
 */
export async function readGhToken(d: { run?: GhRun; candidates?: string[]; exists?: (path: string) => boolean } = {}): Promise<GhToken> {
  const exists = d.exists ?? existsSync;
  const bin = (d.candidates ?? ghCandidates()).find((p) => exists(p));
  if (!bin) return { ok: false, reason: "missing" };
  try {
    const token = (await (d.run ?? runGh)(bin, ["auth", "token", "--hostname", "github.com"])).trim();
    return token ? { ok: true, token } : { ok: false, reason: "signed-out" };
  } catch {
    // gh exits 1 with "no oauth token found for github.com" when signed out. Any other failure ends
    // the same way for the person: this sign-in is not one Realm can use right now.
    return { ok: false, reason: "signed-out" };
  }
}
