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
