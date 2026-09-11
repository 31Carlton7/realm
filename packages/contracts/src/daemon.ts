import { z } from "zod";

/**
 * The file Realm's launcher reads to find a realm-server that is already running.
 *
 * It lives in `@realm/contracts` and not beside the server that writes it because two different
 * packages read it: `apps/server` (which writes it at boot and clears it on shutdown) and
 * `apps/desktop` (which reads it before deciding whether to spawn anything at all). A daemon is
 * exactly the case where the writer and the reader are not the same build, so the shape they agree
 * on is a contract in the same sense the RPC wire is.
 *
 * Nothing here touches the filesystem — the reading and writing live on each side, so this module
 * stays importable from the renderer bundle like the rest of this package.
 */
export const DaemonStateSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  /** Minted once per process at boot, and the only fact that can answer "is the daemon in this file
   *  the one answering on that port". A pid can be reused and a port can be held by something else
   *  entirely; an id the launcher can ask the socket for and compare cannot be either. */
  bootId: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** The RPC token, which is why the file is written 0600. */
  token: z.string().min(1),
  home: z.string().min(1),
  protocol: z.number().int().positive(),
  /** Which CODE the daemon is running, for the update case — see `bundleIdOf`. */
  bundleId: z.string().min(1),
  entry: z.string().min(1),
  startedAt: z.number().int(),
  state: z.enum(["running", "draining"]),
});
export type DaemonState = z.infer<typeof DaemonStateSchema>;

export const DAEMON_STATE_FILE = "daemon.json";
export const DAEMON_LOCK_FILE = "daemon.lock";

/**
 * The wire's version, for a client deciding whether it can talk to a daemon it did not start.
 *
 * Separate from `SERVER_VERSION`, which is a hardcoded string that has never moved and so cannot
 * answer the question. Bump `DAEMON_PROTOCOL` when a change to the RPC surface would make an older
 * renderer misbehave rather than merely miss a feature — added methods and added optional fields do
 * not qualify, since a client that does not call them cannot notice.
 *
 * The MIN/MAX pair is the range THIS app can drive. An adopted daemon outside it is a handoff, not a
 * refusal: the app restarts the daemon rather than telling the user their own server is too old.
 */
export const DAEMON_PROTOCOL = 1;
export const DAEMON_PROTOCOL_MIN = 1;
export const DAEMON_PROTOCOL_MAX = 1;

/**
 * Identity of a server bundle, as "is the daemon running the code this app ships?".
 *
 * Not the version string: `SERVER_VERSION` is a hardcoded "0.0.1" that has never moved, and
 * `install-local.mjs` swaps the bundle without touching it. Not a hash of the bundle's contents
 * either — that would mean reading megabytes on every launch to answer a question one `stat` already
 * answers, and the value is neither a secret nor a claim about contents. Size and mtime from the same
 * `stat` the launcher already does, kept legible so a wedged daemon can be diagnosed by reading the
 * file.
 */
export const bundleIdOf = (stat: { size: number; mtimeMs: number }): string =>
  `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
