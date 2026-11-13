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
  /** The `realm` CLI's token, which is why the file is written 0600. An agent with the sandbox off
   *  can read this file, so the token opens only the CLI's own methods (`rpc/cli-methods.ts`). The
   *  app's own token, which opens everything, is never written here: main hands it to the server
   *  over the spawn pipe and keeps a `safeStorage`-sealed copy in `DAEMON_SEALED_TOKEN_FILE`. */
  token: z.string().min(1),
  /** SHA-256 (hex) of the app's token, so an app reattaching to a running server can tell whether
   *  its sealed copy is this server's. Absent on a server from before the split. */
  appTokenSha256: z.string().optional(),
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
/** The app's token, sealed by Electron's `safeStorage`, for an app reattaching to a daemon that
 *  outlived the one that started it. */
export const DAEMON_SEALED_TOKEN_FILE = "daemon.sealed";
/** Set in the server's environment when its parent writes the app's token as the first line of its
 *  stdin. The value is only a flag; the token never travels in an environment. */
export const APP_TOKEN_STDIN_ENV = "REALM_APP_TOKEN_STDIN";

/**
 * How a handoff is taken when the running daemon is not this build's.
 *
 * `restart` — stop it, start ours. The default, and always correct: sessions resume from their
 * provider ids on the ordinary boot path, runs are requeued, terminals come back with what they
 * printed. `drain` — let it finish what is in flight first. Experimental, because the thing it buys
 * (one mid-flight turn survives) is small against a second code path through shutdown.
 */
export const DAEMON_HANDOFF_MODE_KEY = "daemon.handoffMode";
export const DAEMON_HANDOFF_MODES = ["restart", "drain"] as const;
export type DaemonHandoffMode = (typeof DAEMON_HANDOFF_MODES)[number];
export const DAEMON_HANDOFF_MODE_DEFAULT: DaemonHandoffMode = "restart";
export const resolveHandoffMode = (raw: unknown): DaemonHandoffMode =>
  (DAEMON_HANDOFF_MODES as readonly string[]).includes(raw as string) ? (raw as DaemonHandoffMode) : DAEMON_HANDOFF_MODE_DEFAULT;

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
 * Not the version string: `SERVER_VERSION` is the release a build was cut for, and two builds of one
 * release (or `install-local.mjs` swapping the bundle) share it. Not a hash of the bundle's contents
 * either — that would mean reading megabytes on every launch to answer a question one `stat` already
 * answers, and the value is neither a secret nor a claim about contents. Size and mtime from the same
 * `stat` the launcher already does, kept legible so a wedged daemon can be diagnosed by reading the
 * file.
 */
export const bundleIdOf = (stat: { size: number; mtimeMs: number }): string =>
  `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
