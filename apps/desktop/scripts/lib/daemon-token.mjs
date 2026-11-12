/**
 * The app's RPC token, for a live check that dials realm-server's socket directly.
 *
 * The socket refuses a handshake that does not offer a token as its WebSocket subprotocol — it binds
 * loopback, and loopback is reachable from any web page. `<home>/daemon.json` carries only the
 * `realm` CLI's token, which the server refuses for most methods (`apps/server/src/rpc/cli-methods.ts`):
 * any agent with the sandbox off can read that file. The app's own token exists only in main's
 * memory, so an unpackaged build started with `REALM_LIVE_APP_TOKEN=1` — every launch through
 * `live-app.mjs` — writes it to `<home>/live-app-token` for the check (`src/main/app-token.ts`).
 *
 * `daemonState(home).token` is therefore the app's token when the app wrote one, and the CLI's
 * otherwise; `cliToken` is always the file's own.
 *
 * Polled rather than read once: a script that has seen the app's window is past this, but one racing
 * the ready line can arrive a few milliseconds early.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const LIVE_APP_TOKEN_FILE = "live-app-token";

export function liveAppToken(home) {
  try { return fs.readFileSync(path.join(home, LIVE_APP_TOKEN_FILE), "utf8").trim() || null; } catch { return null; }
}

export function daemonState(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8"));
    if (typeof raw?.token !== "string" || !raw.token) return null;
    return { ...raw, cliToken: raw.token, token: liveAppToken(home) ?? raw.token };
  } catch {
    return null;
  }
}

/**
 * For a check that spawns realm-server itself, as main does: started with `REALM_APP_TOKEN_STDIN=1`
 * and a piped stdin, it reads the app's token from there. The token is also left in
 * `<home>/live-app-token`, where `daemonToken` finds it.
 */
export function handOverAppToken(child, home) {
  const token = randomBytes(32).toString("base64url");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, LIVE_APP_TOKEN_FILE), token, { mode: 0o600 });
  child.stdin.end(`${token}\n`);
  return token;
}

export async function daemonToken(home, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = daemonState(home);
    if (state) return state.token;
    if (Date.now() > deadline) throw new Error(`no readable ${path.join(home, "daemon.json")} after ${timeoutMs}ms — realm-server never wrote its state file`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The subprotocol list to hand `new WebSocket(url, protocols)`. */
export const tokenProtocols = (token) => [`realm.${token}`];

/**
 * Stop every daemon that has run on this home, for a live check's cleanup.
 *
 * Two passes with a pause between them, because one is not enough: a check that fails midway may have
 * a REPLACEMENT daemon still booting, and it writes its state file after the first read. A single
 * pass then leaves it running on a scratch directory that is about to be deleted — and holding the
 * fixed port, so the next run of that same check refuses to start. (Which is exactly what happened.)
 *
 * `known` is every pid the check saw along the way; the file is consulted for the ones it did not.
 */
export async function stopDaemons(home, known = []) {
  const pids = new Set(known.filter(Boolean));
  for (let pass = 0; pass < 2; pass++) {
    const state = daemonState(home);
    if (state?.pid) pids.add(state.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await new Promise((r) => setTimeout(r, 600));
  }
  return [...pids];
}
