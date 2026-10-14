import { z } from "zod";
import type { BrowserCredential } from "./browser-agent";

/**
 * Realm's passwords, beyond the sign-ins Settings has always taken (Realm 2.3): passwords imported
 * from a file the Passwords app (or Chrome, 1Password, Bitwarden) exported, internet passwords in the
 * macOS login keychain, and passwords a pane offers to save after a form is sent. They are all
 * `BrowserCredential`s — the same shape with no field for a value — so every rule that type carries
 * carries over: nothing here moves a password across a process boundary except toward a page the user
 * chose, or onto the clipboard and into a native sheet after Touch ID.
 *
 * Apple gives other apps no way into the Passwords app or iCloud Keychain, so those reach Realm as an
 * export the user makes (`PASSWORDS_IMPORT_NOTE`). The login keychain is reachable, and is read in
 * place: Realm lists what is in it and reads one password at the moment it fills it, when macOS asks
 * the user first (`KEYCHAIN_PASSWORDS_NOTE`).
 */

/** How a saved password relates to the page a pane is on (desktop `password-match.ts`). `exact` is
 *  the same origin. `same-site` is the same registrable domain under the public-suffix list — a
 *  password saved for www.example.com on login.example.com — or one saved for http:// on the same
 *  site's https://. Never the other way round: a password saved for https:// is not offered on
 *  http://. */
export type PasswordSiteMatch = "exact" | "same-site";

/** A password offered for one page: what the pane's menu lists, and what `browser_credentials` tells
 *  an agent about the site it is on. Metadata, like every `BrowserCredential`. */
export type SiteCredential = BrowserCredential & {
  match: PasswordSiteMatch;
  /** The user answered "Always allow" to an agent filling this password on this page's exact origin.
   *  The card is skipped then; the profile's unlock policy (Touch ID by default) still applies. */
  agentAllowed: boolean;
};

/** A standing "Always allow" for agents: one password, on one exact origin. Listed and removed in
 *  Settings ▸ Passwords; nothing else removes one, and an agent can make one only by the person
 *  answering "Always allow" on the fill's own card. */
export type PasswordFillAllow = { credentialId: string; origin: string; setAt: number };

/**
 * A password a pane offers to keep after the page sent a sign-in form. `origin` is the pane's own
 * top-level origin as the browser reported it, never the form's action or anything the page wrote;
 * `username` is what the form held. There is no field for the password: main holds it until the
 * person answers, and forgets it when they do, when the pane goes, or after `SAVE_OFFER_TTL_MS`.
 */
export type PasswordSaveOffer = {
  browserId: string;
  offerId: string;
  origin: string;
  username: string;
  /** `update`: the profile already holds a password for this site and username, and this one differs. */
  kind: "save" | "update";
};

export const PasswordSaveAnswerSchema = z.enum(["save", "never", "dismiss"]);
export type PasswordSaveAnswer = z.infer<typeof PasswordSaveAnswerSchema>;

/** How long a save offer waits for an answer before main forgets the password it was holding. */
export const SAVE_OFFER_TTL_MS = 5 * 60_000;

/** Editing a saved password in Settings. `value` absent leaves the password as it is; present, it is
 *  the one other renderer→main channel a value travels, the same one-way shape as enrollment. */
export const BrowserCredentialEditSchema = z.object({
  username: z.string().max(255),
  label: z.string().max(255),
  value: z.string().min(1).max(4096).optional(),
});
export type BrowserCredentialEdit = z.infer<typeof BrowserCredentialEditSchema>;

/** What an import did, in counts. Never a row, a site or a username: the file is the user's to read,
 *  and a summary that quoted it would be the file again in another place. */
export type PasswordImportResult =
  | { ok: true; added: number; updated: number; unchanged: number; skipped: number; fileName: string; trashed: boolean }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

/** The login keychain, as Settings shows it. `supported` is false off macOS or with no helper. */
export type KeychainPasswordsStatus = {
  supported: boolean;
  enabled: boolean;
  /** How many internet passwords Realm can offer from it; null until listed, or when listing failed. */
  count: number | null;
  error: string | null;
};

/** What Show password and Copy password answered. The value itself never comes back: Show draws it in
 *  a native sheet and Copy puts it on the clipboard, both from main. */
export type PasswordRevealResult = { ok: true } | { ok: false; error: string };

/** How long a copied password stays on the clipboard before Realm clears it — if it is still there. */
export const PASSWORD_CLIPBOARD_CLEAR_MS = 30_000;

export const PASSWORDS_IMPORT_NOTE =
  "Apple doesn't let other apps read the Passwords app or iCloud Keychain. In Passwords, choose File ▸ Export All Passwords, then import that file here. Realm encrypts what it imports and offers to move the file to the Trash, since it holds every password in plain text.";

export const KEYCHAIN_PASSWORDS_NOTE =
  "Realm lists the internet passwords in your login keychain — site and username only — and reads one when you fill it. macOS asks you first, and Realm keeps no copy.";
