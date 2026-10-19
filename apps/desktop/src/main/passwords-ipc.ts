import { createHash } from "node:crypto";
import {
  BrowserCredentialEditSchema, PASSWORD_CLIPBOARD_CLEAR_MS,
  type BrowserCredential, type KeychainPasswordsStatus, type PasswordFillAllow, type PasswordImportResult, type PasswordRevealResult,
} from "@realm/contracts";
import { PASSWORD_EXPORT_MAX_BYTES, parsePasswordExport } from "./password-csv";
import { SecretStoreError, type SecretStore, type SetAside } from "./secret-store";

/**
 * Settings ▸ Passwords over renderer IPC: import, edit, Show, Copy, the login keychain switch, the
 * sites that are never offered a save, and agents' "Always allow" — Realm 2.3's additions to
 * Settings ▸ Sign-ins, which keep its rules.
 *
 * Renderer IPC on purpose, as everything that changes a saved password is: a page cannot reach the
 * renderer, and an agent cannot call it — there is no RPC method, MCP tool or bridge op beside any of
 * these, and the controls that send them carry `data-no-agent`, so an agent driving Realm's own window
 * cannot press them either.
 *
 * And no value comes back over it. Show puts the password in a native sheet and Copy on the clipboard,
 * both from main; the renderer is told only whether that happened. A renderer is a page Realm can be
 * asked to read (an agent's snapshot of Realm's window), and the sheet is not in it.
 */
export type PasswordsIpcDeps = {
  handle(channel: string, fn: (sender: unknown, ...args: unknown[]) => unknown): void;
  secrets(): SecretStore | null;
  resolveProfile(id: string): Promise<{ id: string } | null>;
  /** The system's open panel, for one CSV; null when the person cancelled. */
  pickExport(sender: unknown): Promise<string | null>;
  readFile(path: string): Promise<{ size: number; text: () => Promise<string> }>;
  /** Ask whether to move the export to the Trash, and do it on yes. Whether it went. */
  offerToTrash(sender: unknown, path: string): Promise<boolean>;
  /** Draw the password in a native sheet over the window that asked. Resolves when it is closed;
   *  true when the person pressed its Copy. */
  showPassword(sender: unknown, title: string, value: string): Promise<boolean>;
  clipboard: { writeText(text: string): void; readText(): string; clear(): void };
  setTimer(fn: () => void, ms: number): void;
  /** Select a file in Finder. */
  reveal(path: string): void;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function registerPasswordsIpc(d: PasswordsIpcDeps): void {
  const owned = async (profileId: unknown) => {
    const store = d.secrets();
    const owner = await d.resolveProfile(str(profileId));
    return store && owner ? { store, owner } : null;
  };

  /**
   * Put a password on the clipboard and take it off again after `PASSWORD_CLIPBOARD_CLEAR_MS` — if it
   * is still what is there. Only a digest is kept for that comparison: main holds no copy of the value
   * for the thirty seconds, and something the person copied since is left alone.
   */
  const copy = (value: string) => {
    d.clipboard.writeText(value);
    const digest = createHash("sha256").update(value).digest("hex");
    d.setTimer(() => {
      if (createHash("sha256").update(d.clipboard.readText()).digest("hex") === digest) d.clipboard.clear();
    }, PASSWORD_CLIPBOARD_CLEAR_MS);
  };

  d.handle("credentials:update", async (_sender, profileId, id, edit): Promise<BrowserCredential | null> => {
    const ready = await owned(profileId);
    if (!ready) throw new Error("That profile no longer exists.");
    const parsed = BrowserCredentialEditSchema.safeParse(edit);
    // Not forwarded: the zod error echoes the input, and the input can be the password.
    if (!parsed.success) throw new Error("That change is missing something — check the fields.");
    try { return ready.store.updateCredential(ready.owner.id, str(id), parsed.data); } catch (e) {
      throw new Error(e instanceof SecretStoreError ? e.message : "That password could not be changed.");
    }
  });

  d.handle("credentials:import", async (sender, profileId): Promise<PasswordImportResult> => {
    const ready = await owned(profileId);
    if (!ready) return { ok: false, error: "That profile no longer exists." };
    const path = await d.pickExport(sender);
    if (!path) return { ok: false, cancelled: true };
    const file = await d.readFile(path).catch(() => null);
    if (!file) return { ok: false, error: "Realm couldn't read that file." };
    if (file.size > PASSWORD_EXPORT_MAX_BYTES) return { ok: false, error: "That file is too large to be a password export." };
    const parsed = parsePasswordExport(await file.text());
    if (!parsed.ok) return { ok: false, error: parsed.error };
    let counts: { added: number; updated: number; unchanged: number };
    try { counts = ready.store.importCredentials(ready.owner.id, parsed.rows); } catch (e) {
      return { ok: false, error: e instanceof SecretStoreError ? e.message : "The passwords could not be imported." };
    }
    const trashed = await d.offerToTrash(sender, path).catch(() => false);
    return { ok: true, ...counts, skipped: parsed.skipped, fileName: path.split("/").pop() ?? path, trashed };
  });

  d.handle("credentials:reveal", async (sender, profileId, id, action): Promise<PasswordRevealResult> => {
    const ready = await owned(profileId);
    if (!ready) return { ok: false, error: "That profile no longer exists." };
    const what = action === "copy" ? "copy" : "show";
    const row = ready.store.getCredential(ready.owner.id, str(id));
    const r = await ready.store.withCredentialValueForPerson(ready.owner.id, str(id), what, async (value) => {
      if (what === "copy") { copy(value); return; }
      const title = row ? `${row.username ? `${row.username} on ` : ""}${new URL(row.origin).host}` : "Password";
      if (await d.showPassword(sender, title, value)) copy(value);
    });
    if (r.ok) return { ok: true };
    return { ok: false, error: r.refused === "no_presence" ? "macOS didn't confirm it was you, so the password stays hidden." : "That password is no longer saved here." };
  });

  d.handle("credentials:keychain-status", (): KeychainPasswordsStatus =>
    d.secrets()?.keychainStatus() ?? { supported: false, enabled: false, count: null, error: null });
  d.handle("credentials:set-keychain", async (_sender, enabled): Promise<KeychainPasswordsStatus> =>
    (await d.secrets()?.setKeychainEnabled(enabled === true)) ?? { supported: false, enabled: false, count: null, error: null });
  d.handle("credentials:keychain-list", async (): Promise<BrowserCredential[]> => {
    const store = d.secrets();
    if (!store) return [];
    await store.refreshKeychain();
    return store.fromKeychain();
  });

  d.handle("credentials:never-list", async (_sender, profileId): Promise<string[]> => {
    const ready = await owned(profileId);
    return ready ? ready.store.neverSaveSites(ready.owner.id) : [];
  });
  d.handle("credentials:set-never", async (_sender, profileId, origin, never): Promise<string[]> => {
    const ready = await owned(profileId);
    return ready ? ready.store.setNeverSave(ready.owner.id, str(origin), never === true) : [];
  });

  /* A store Realm could not read, kept aside: what the notice says, its Show in Finder, and the
     person having read it. The path comes from the store, never from the renderer. */
  d.handle("credentials:unreadable", (): SetAside | null => d.secrets()?.unreadableNotice() ?? null);
  d.handle("credentials:reveal-unreadable", (): void => {
    const notice = d.secrets()?.unreadableNotice();
    if (notice) d.reveal(notice.path);
  });
  d.handle("credentials:dismiss-unreadable", (): void => { d.secrets()?.dismissUnreadableNotice(); });
  /* Saved sign-ins the Keychain will not open for Realm right now, and Settings' Try again. */
  d.handle("credentials:keychain-needed", (): boolean => d.secrets()?.keychainNeeded() ?? false);
  d.handle("credentials:retry-keychain", (): boolean => d.secrets()?.retryKeychain() ?? false);

  d.handle("credentials:fill-allows", async (_sender, profileId): Promise<PasswordFillAllow[]> => {
    const ready = await owned(profileId);
    return ready ? ready.store.fillAllows(ready.owner.id) : [];
  });
  d.handle("credentials:clear-fill-allow", async (_sender, profileId, credentialId, origin): Promise<boolean> => {
    const ready = await owned(profileId);
    return ready ? ready.store.clearFillAllow(ready.owner.id, str(credentialId), str(origin)) : false;
  });
}
