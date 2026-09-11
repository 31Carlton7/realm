/**
 * The reading half of `~/Realm/daemon.json` — the shape itself lives in `@realm/contracts`, which is
 * where a file two packages agree on belongs.
 *
 * Main reads this file for one thing today: the RPC token, which the server mints at boot and never
 * puts on stdout. Everything that dials realm-server from this process or from the renderer needs
 * it, and the file is the only place it exists.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_STATE_FILE, DaemonStateSchema, type DaemonState } from "@realm/contracts";

/**
 * Where `~/Realm` is — resolved HERE rather than read back from the server, because adoption has to
 * find `daemon.json` before any server exists to ask. It mirrors `apps/server/src/paths.ts`, and the
 * two cannot drift: main passes this value to every server it spawns as REALM_HOME, so the server
 * agrees by construction rather than by coincidence.
 */
export const realmHomePath = (): string => process.env.REALM_HOME ?? join(homedir(), "Realm");

export const daemonStatePath = (home: string): string => join(home, DAEMON_STATE_FILE);

/** The state file, or null for every kind of absence: no file, unreadable, not JSON, wrong shape.
 *  Never throws — this runs on the path that decides whether the app can start at all. */
export function readDaemonState(home: string): DaemonState | null {
  let raw: string;
  try { raw = readFileSync(daemonStatePath(home), "utf8"); } catch { return null; }
  try {
    const parsed = DaemonStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/**
 * The state of the server we just started, identified by the port it told us on stdout.
 *
 * The port check is the point: a leftover file from a previous run parses perfectly and hands out a
 * token for a socket that is gone. The server writes this file before it writes its ready line, so
 * by the time a caller has a port, the matching file is already on disk.
 */
export function readStateForPort(home: string, port: number): DaemonState | null {
  const state = readDaemonState(home);
  return state && state.port === port ? state : null;
}
