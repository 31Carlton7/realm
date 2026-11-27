/**
 * Security codes: the one-time code a site just sent by text or email, offered in a browser pane's
 * code field the way Safari offers it, and filled for an agent only while agent sign-ins are on.
 *
 * Electron main reads the codes, on this Mac only, and only while Settings ▸ Sign-ins ▸ Security
 * codes is on — which it is not until the user turns it on. A code is read when a code field is
 * clicked or an agent's fill runs, from messages that arrived in the last `SECURITY_CODE_WINDOW_MS`,
 * and it is kept in memory for that fill alone. Nothing here carries a code: the status says which
 * sources Realm can read, and an agent's fill answers "filled" or why it did not.
 */

/** How far back a message may have arrived and still be offered. */
export const SECURITY_CODE_WINDOW_MS = 5 * 60_000;

/** How long an agent's fill waits for a code that has not arrived yet. */
export const SECURITY_CODE_WAIT_MS = 90_000;

/** Where a code came from, as the menu row and the card name it. */
export type SecurityCodeSourceName = "Messages" | "Mail" | "Notifications";

/**
 * Whether Realm can read a source right now: `ok`; `no_access` when macOS refused the read (Full
 * Disk Access is off for Realm); `missing` when there is nothing on this Mac to read (no Messages
 * database, or no `mac` command for Mail, or no Notification Center database).
 */
export type SecurityCodeSourceState = "ok" | "no_access" | "missing";

export type SecurityCodesStatus = {
  enabled: boolean;
  /** Only read while `enabled`; null when off, because Realm does not look while it is off. */
  sources: Record<SecurityCodeSourceName, SecurityCodeSourceState> | null;
};

/** What Settings says under the switch, and what the switch's tooltip spells out. */
export const SECURITY_CODES_NOTE =
  "When you click into a code field in a browser pane, Realm reads the messages and emails that arrived on this Mac in the last 5 minutes, finds a one-time code in them, and offers it under the field. "
  + "It reads nothing while this is off, keeps nothing it reads, and never sends a code anywhere. An agent can fill a code only while Let agents finish sign-ins is on, and is never told the code.";
