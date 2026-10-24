import { PRODUCTION_REMOTE_RELAY, STAGING_REMOTE_RELAY } from "@realm/contracts";
import { relayBase } from "@realm/remote";

/**
 * The relay a Mac dials when its `remote.relay` setting names none: `REALM_RELAY` where that names a
 * relay, as a live check or a released app pointed at staging would; else staging for a development
 * build (`pnpm dev`, whose window is the Vite server, which is how this server knows it is one); else
 * production, which every released Realm dials and every public pairing names. A Mac that moves from
 * one to the other takes its phones with it (PROTOCOL.md §3.3).
 */
export function defaultRelay(env: Record<string, string | undefined>): string {
  return relayBase(env.REALM_RELAY) ?? (env.ELECTRON_RENDERER_URL ? STAGING_REMOTE_RELAY : PRODUCTION_REMOTE_RELAY);
}
