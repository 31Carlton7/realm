import type { MacRoom } from "./durable";

export type Env = {
  MAC_ROOM: DurableObjectNamespace<MacRoom>;
  /** Vars, from wrangler.jsonc. */
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
  /** Secrets, set with `wrangler secret put`. Without them a push answers `apns-not-configured`. */
  APNS_KEY_ID?: string;
  APNS_KEY_P8?: string;
  /** Sends APNs requests here instead of to Apple. Only the tests set it. */
  APNS_ORIGIN?: string;
};
