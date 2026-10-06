import { utf8 } from "./bytes";

/** PROTOCOL.md §4's prologues: a label, then the ids the handshake belongs to, each separated by a zero
 *  byte. Binding the ids into the handshake hash is what stops a frame recorded for one pair being
 *  replayed into another. */
const prologue = (label: string, a: string, b: string): Buffer =>
  Buffer.concat([utf8(label), Buffer.from([0]), utf8(a), Buffer.from([0]), utf8(b)]);

export const PROLOGUE = {
  pair: (macId: string, windowId: string): Buffer => prologue("realm-pair/1", macId, windowId),
  ik: (macId: string, phoneId: string): Buffer => prologue("realm-mobile/1", macId, phoneId),
  push: (macId: string, phoneId: string): Buffer => prologue("realm-push/1", macId, phoneId),
};

export type RelayRole = "mac" | "phone";

/** The exact bytes a Mac or phone signs to answer the relay's challenge (§3.1). */
export const relayAuthMessage = (role: RelayRole, macId: string, phoneId: string | null, nonce: string): Buffer =>
  utf8(`realm-relay/1\n${role}\n${macId}\n${phoneId ?? ""}\n${nonce}`);

/** §3: a Mac and its phones send this every 20 s; the relay answers without waking. */
export const HEARTBEAT_MS = 20_000;
export const PING = "ping";

/** §3.1's close codes, named. */
export const CLOSE = {
  malformed: 4400,
  unauthorized: 4401,
  forbidden: 4403,
  authTimeout: 4408,
  replaced: 4409,
  removed: 4410,
  tooLarge: 4413,
  channelClosed: 4000,
} as const;

/** The 16-byte channel id that prefixes every binary message on the Mac's socket (§3.2). */
export const CHANNEL_ID_BYTES = 16;
