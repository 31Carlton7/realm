import { z } from "zod";
import { IdSchema, Timestamps } from "./entities";

/**
 * Machines (Plan 25 W3): a screen somewhere else, shown and driven inside a pane.
 *
 * The `source` is what Realm has to DO to get pixels, and the four differ enough that nothing below
 * pretends they are the same thing:
 *
 *   - `vnc` — an address someone else is already serving. Realm connects; it starts nothing and
 *     stops nothing. A second Mac with Screen Sharing on is this, and so is a cloud sandbox.
 *   - `qemu` — a guest Realm boots on this Mac (Plan 25 W5). Realm owns the process, the disk image
 *     and the port, and speaks QMP to it beside the pixels.
 *   - `mac` — this Mac's own screen, through the computer-use helper (Plan 25 W7).
 *   - `container` — a container Realm runs with a virtual display, after which it is a `vnc` (W7).
 *
 * Only `vnc` is built. The others are in the enum because the enum is what a stored row is validated
 * against and a source added later must not fail to parse a row written by a newer build — but every
 * one of them is refused at the service, by name, rather than silently doing nothing.
 */
export const MachineSourceSchema = z.enum(["vnc", "qemu", "mac", "container"]);
export type MachineSource = z.infer<typeof MachineSourceSchema>;

/**
 * What a machine is doing right now.
 *
 * Deliberately NOT a column on the row. Status is a fact about a process or a socket, and neither
 * survives a restart — a stored one would have to be rewritten to `off` at every boot, and would be
 * a lie for the whole window in which a machine was killed while Realm was down. `terminals` has no
 * status column for exactly this reason.
 *
 * `booting` covers "Realm is trying to reach it" for every source, including the connect a `vnc`
 * machine does — a remote Mac that is asleep looks identical to a guest that has not finished its
 * firmware, and neither is `running` until pixels arrive.
 */
export const MachineStatusSchema = z.enum(["off", "booting", "running", "suspended", "failed"]);
export type MachineStatus = z.infer<typeof MachineStatusSchema>;

/**
 * How Realm dials the far end. Four, because there are four genuinely different things to do with a
 * socket, and every host worth reaching is one of them.
 *
 *   - `tcp`  — RFB straight onto a port. Another Mac with Screen Sharing on, a container with 5900
 *              published, Modal's `unencrypted_ports`.
 *   - `tls`  — the same, inside TLS. Modal's `tls_socket`, and anything behind a TLS TCP proxy.
 *   - `ws` / `wss` — RFB inside a WebSocket, which is what `websockify` serves. This is the only
 *              shape a sandbox behind an HTTP reverse proxy can take, and it is what E2B Desktop,
 *              Vercel Sandbox and Namespace's HTTP ingress all reduce to.
 *
 * A browser could open the third of these itself and nothing else — which is the short version of
 * why the relay is server-side rather than a convenience.
 */
export const MachineTransportSchema = z.enum(["tcp", "tls", "ws", "wss"]);
export type MachineTransport = z.infer<typeof MachineTransportSchema>;

/** Where a `vnc` machine lives. The password is NOT here and never travels: the server holds it and
 *  performs the RFB handshake itself, so the renderer is handed an already-authenticated socket. */
export const VncEndpointSchema = z.object({
  transport: MachineTransportSchema.default("tcp"),
  host: z.string().min(1).max(255),
  /** RFB's own default. macOS Screen Sharing is 5900; a `:1` X display is 5901, and so on. For a
   *  WebSocket this is the URL's port — 443 for `wss`, which is what every hosted sandbox uses. */
  port: z.number().int().min(1).max(65535).default(5900),
  /** WebSocket only: where the far end serves the upgrade. `websockify`'s own default, which noVNC
   *  and therefore every sandbox that embeds it also uses. Ignored by `tcp` and `tls`. */
  path: z.string().max(512).default("/websockify"),
});
export type VncEndpoint = z.infer<typeof VncEndpointSchema>;

export const MachineSchema = z.object({
  id: IdSchema,
  spaceId: IdSchema,
  name: z.string().min(1).max(120),
  source: MachineSourceSchema,
  /** Set for `vnc` and `container`; null for a source that has no address of its own. */
  endpoint: VncEndpointSchema.nullable().default(null),
  /** True once a password has been sealed for this machine — never the password, and never a hint
   *  about its length. The connect form reads this to say "saved" instead of showing an empty box. */
  hasPassword: z.boolean().default(false),
  ...Timestamps,
});
export type Machine = z.infer<typeof MachineSchema>;

/**
 * The live half, broadcast on `machine.status` and held in the renderer's store.
 *
 * `wsPort` rides the event rather than being fetched afterwards: a renderer that had to call
 * `machines.get` on every status change would open its socket a round trip late, and the one thing
 * a viewer must not do is show a stale frame while a new connection is already available.
 *
 * `error` is a WORD, not a sentence, and the pane turns it into one. A code survives translation,
 * grep and a changed message; a sentence chosen by the server is a string the UI cannot reason about.
 */
export const MachineStateSchema = z.object({
  machineId: IdSchema,
  status: MachineStatusSchema,
  /** The loopback WebSocket the renderer's RFB client connects to, with its one-time token already
   *  in the path. Null unless `status` is `booting` or `running`. */
  wsUrl: z.string().nullable().default(null),
  /** The guest's framebuffer size, once the connection has reported one. */
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  error: z.string().max(64).nullable().default(null),
  /** The server's own words for what went wrong, verbatim, for the `failed` body's detail well.
   *  Bounded here rather than at the render, which is the last place that knows the difference
   *  between "a server said something long" and "this did not come from the server". */
  detail: z.string().max(2000).nullable().default(null),
});
export type MachineState = z.infer<typeof MachineStateSchema>;

/**
 * Every terminal failure is one of these, and each one is a different thing for a person to do.
 * A spinner that simply stops is the failure this enum exists to make impossible.
 */
export const MACHINE_ERRORS = [
  /** Nothing is listening at that address and port. */
  "unreachable",
  /** Something answered, but not with an RFB handshake — the wrong port, or a different protocol. */
  "not_rfb",
  /** The server wants a password and Realm has none, or the one it has was refused. */
  "auth_failed",
  /** The server offers only security types Realm does not implement. */
  "auth_unsupported",
  /** The connection was open and went away. */
  "disconnected",
  /** macOS would not give Realm an encryption key, so a password cannot be stored at all. */
  "no_secret_store",
  /** The source is in the schema but not built in this release. */
  "source_unavailable",
] as const;
export type MachineError = (typeof MACHINE_ERRORS)[number];

/** The gateway name `realm-vm`'s tools arrive under, mirroring `COMPUTER_PROVIDER_NAME`. */
export const MACHINE_PROVIDER_NAME = "realm-vm";

/** What an agent may ask a machine to do (Plan 25 W4). Declared here with the rest so the renderer's
 *  action ticker and the provider speak one vocabulary rather than two. */
export const VmActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), x: z.number().int().min(0), y: z.number().int().min(0), button: z.enum(["left", "middle", "right"]).default("left") }),
  z.object({ kind: z.literal("type"), text: z.string().max(2000) }),
  z.object({ kind: z.literal("key"), key: z.string().min(1).max(24) }),
  z.object({ kind: z.literal("scroll"), x: z.number().int().min(0), y: z.number().int().min(0), deltaY: z.number().int() }),
]);
export type VmAction = z.infer<typeof VmActionSchema>;
