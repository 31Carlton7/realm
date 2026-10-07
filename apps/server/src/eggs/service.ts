import { isSealed, open as openSealed, seal, SECRET_KEY_BYTES } from "@realm/contracts/src/secret-box";
import type { SealedEggPack, UnlockedEggPack } from "@realm/contracts";
import type { SettingsStore } from "../store/settings";
import { openPack } from "./seal";
import { EGG_PACKS } from "./packs";

/**
 * Which friend packs this Realm has been given the words for.
 *
 * The passphrase is tried against every pack in turn rather than being told which one it belongs
 * to. That is not only simpler — it is the interaction: somebody is handed a word, not a word and a
 * group name, and being asked to pick the group first would give away the list of groups.
 *
 * What is remembered between launches is the PASSPHRASE, not the opened contents. Two reasons, and
 * the second is the real one: a decrypted pack in `settings` would put the jokes in `realm.db` in
 * the clear, which is the thing the sealing exists to prevent — a database that travels in a backup,
 * a screen share, or a support bundle. Sealed with the desktop app's key where there is one, which
 * is the same treatment a machine password gets.
 */
export const EGGS_UNLOCKED_KEY = "eggs.unlocked";

/** The box for the stored passphrases. Its own domain, so a blob from here cannot be opened as a
 *  machine password and vice versa — `secret-box.ts` mixes the domain in as AAD. */
export const eggSecretBox = {
  key: null as Buffer | null,
  setKey(base64: string | null): void {
    if (!base64) { this.key = null; return; }
    let buf: Buffer;
    try { buf = Buffer.from(base64, "base64"); } catch { this.key = null; return; }
    this.key = buf.length === SECRET_KEY_BYTES ? buf : null;
  },
  /**
   * Ciphertext where a key exists, PLAINTEXT where none does — the `oauth` box's choice rather than
   * the `machine` box's refusal, and the difference is what is at stake. A machine password is
   * frequently the user's login to a computer they own, so writing one in the clear is not a
   * degradation to choose for them. This is a word that unlocks a joke about somebody's friends: the
   * loss if `realm.db` leaks is embarrassment, and refusing to remember it would mean typing a
   * passphrase at every launch for the rest of the app's life.
   */
  seal(passphrase: string): string {
    return this.key ? seal(this.key, "eggs", passphrase) : passphrase;
  },
  open(stored: string): string | null {
    if (!isSealed(stored)) return stored; // written before a key existed, or on a build without one
    return this.key ? openSealed(this.key, "eggs", stored) : null;
  },
};

export type EggServiceDeps = {
  settings: SettingsStore;
  /** The sealed packs. Injected so a test can ship its own rather than the real friends'. */
  packs?: readonly SealedEggPack[];
};

export class EggService {
  private readonly open = new Map<string, UnlockedEggPack>();
  private readonly packs: readonly SealedEggPack[];

  constructor(private readonly d: EggServiceDeps) {
    this.packs = d.packs ?? EGG_PACKS;
  }

  /** Every pack whose word this Realm has been given. */
  unlocked(): UnlockedEggPack[] { return [...this.open.values()]; }

  /**
   * Try a word against every pack. Returns the one it opened, or null.
   *
   * Deliberately says nothing about near-misses: there is no "that is the right word for a group you
   * have already unlocked" and no count of how many packs exist. The only two answers are a pack and
   * nothing.
   */
  unlock(passphrase: string): UnlockedEggPack | null {
    const word = passphrase.trim();
    if (!word) return null;
    for (const sealed of this.packs) {
      const pack = openPack(word, sealed);
      if (!pack) continue;
      const entry = { ...pack, id: sealed.id };
      this.open.set(sealed.id, entry);
      this.remember(sealed.id, word);
      return entry;
    }
    return null;
  }

  /** Forget a group: the pack closes and its word is dropped. Nothing is deleted from the repo — the
   *  same word opens it again. */
  forget(id: string): void {
    if (!this.open.delete(id)) return;
    const stored = this.stored();
    delete stored[id];
    this.d.settings.set(EGGS_UNLOCKED_KEY, stored);
  }

  /** Boot: re-open everything whose word was remembered. A word that no longer opens its pack — the
   *  pack was re-sealed with a different one — is dropped rather than kept as a broken entry. */
  restore(): number {
    const stored = this.stored();
    let opened = 0;
    let changed = false;
    for (const [id, blob] of Object.entries(stored)) {
      const sealedPack = this.packs.find((p) => p.id === id);
      const word = typeof blob === "string" ? eggSecretBox.open(blob) : null;
      const pack = sealedPack && word ? openPack(word, sealedPack) : null;
      if (!pack) { delete stored[id]; changed = true; continue; }
      this.open.set(id, { ...pack, id });
      opened++;
    }
    if (changed) this.d.settings.set(EGGS_UNLOCKED_KEY, stored);
    return opened;
  }

  private remember(id: string, passphrase: string): void {
    this.d.settings.set(EGGS_UNLOCKED_KEY, { ...this.stored(), [id]: eggSecretBox.seal(passphrase) });
  }

  /** The stored map, defensively: anything that is not an object of strings reads as empty rather
   *  than taking the unlock path down with it. */
  private stored(): Record<string, string> {
    const raw = this.d.settings.get(EGGS_UNLOCKED_KEY);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  }
}
