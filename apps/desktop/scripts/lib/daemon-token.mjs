/**
 * The RPC token, for a live check that dials realm-server's socket directly.
 *
 * The socket refuses a handshake that does not offer `realm.<token>` as its WebSocket subprotocol —
 * it binds loopback, and loopback is reachable from any web page. The token is minted at boot and
 * written only to `<home>/daemon.json` at 0600, never to stdout, so a script that wants on the
 * socket reads it from the scratch home it already chose.
 *
 * Polled rather than read once: a script that has seen the app's window is past this, but one racing
 * the ready line can arrive a few milliseconds early.
 */
import fs from "node:fs";
import path from "node:path";

export function daemonState(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8"));
    return typeof raw?.token === "string" && raw.token ? raw : null;
  } catch {
    return null;
  }
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
