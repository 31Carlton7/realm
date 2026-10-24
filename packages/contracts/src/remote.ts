import { z } from "zod";

/**
 * Realm Mobile on the Mac (Plan 28, Phase 2): what Settings ▸ Devices and the Notifications page ask
 * the server, and what the server tells them. The phone's own API is `mobile.v1` in @realm/remote;
 * nothing here is reachable from a phone.
 */

/** The relay this Mac dials, when it is not the one its build would dial. One deployment serves every
 *  Mac. Unset, a released build dials production and a development build staging. */
export const REMOTE_RELAY_KEY = "remote.relay";
/** Realm's two relays, as services/relay/wrangler.jsonc deploys them. */
export const PRODUCTION_REMOTE_RELAY = "wss://realm-relay.realm-relay.workers.dev";
export const STAGING_REMOTE_RELAY = "wss://realm-relay-staging.realm-relay.workers.dev";

/** Whether the moments `RELAYED_CATEGORIES` names also go to paired phones as pushes. On by default:
 *  pairing a phone is the opt-in, and the row only appears once one is paired. */
export const NOTIFICATIONS_IPHONE_KEY = "notifications.relay.iphone";

/**
 * The link to the relay, as Settings shows it.
 * - `off`: no phone paired and no pairing open, so the Mac does not dial at all.
 * - `connecting` / `connected` / `offline`: the outbound socket's state.
 * - `locked`: the daemon has no key to open its identity with (it restarted with no Realm window
 *   attached, so Electron main has not handed the key over yet).
 */
export const RemoteStateSchema = z.enum(["off", "connecting", "connected", "offline", "locked"]);
export type RemoteState = z.infer<typeof RemoteStateSchema>;

export const PairedPhoneSchema = z.object({
  phoneId: z.string(),
  name: z.string(),
  model: z.string(),
  addedAt: z.number(),
  lastSeen: z.number().nullable(),
});
export type PairedPhone = z.infer<typeof PairedPhoneSchema>;

export const PairingWindowSchema = z.object({
  windowId: z.string(),
  /** The link the QR code carries (PROTOCOL.md §2). */
  url: z.string(),
  expiresAt: z.number(),
});
export type PairingWindow = z.infer<typeof PairingWindowSchema>;

export const RemoteStatusSchema = z.object({
  state: RemoteStateSchema,
  relay: z.string(),
  macName: z.string(),
  phones: z.array(PairedPhoneSchema),
  pairing: PairingWindowSchema.nullable(),
});
export type RemoteStatus = z.infer<typeof RemoteStatusSchema>;

/** A phone that proved it holds the QR code's secret and is waiting on the owner's yes (§4.1). */
export const PairRequestSchema = z.object({
  requestId: z.string(),
  windowId: z.string(),
  name: z.string(),
  model: z.string(),
});
export type PairRequest = z.infer<typeof PairRequestSchema>;
