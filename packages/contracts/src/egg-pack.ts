import { z } from "zod";

/**
 * Friend packs: the easter eggs that name real people, which do not ship in the clear.
 *
 * Realm is open source and these jokes are not. The names, the nicknames and the in-references
 * belong to people who did not publish them, so the repository carries only a sealed blob per group
 * and the passphrase is the key that opens it. Nothing here is recoverable from the source: the
 * ciphertext is authenticated, so a wrong passphrase does not decrypt to garbage — it fails.
 *
 * **What this is and is not.** It is a lock on the contents, not a proof against a determined
 * attacker: the passphrases are short words a friend can remember, and an offline attack against a
 * short word is always feasible given the blob. `scrypt` at the parameters in `EGG_KDF` makes each
 * guess cost real time and 64 MB of memory, which stops casual reading and a shell script — and
 * stops neither a GPU nor patience. The honest summary for anyone choosing a passphrase: this keeps
 * the joke off the internet, it does not keep a secret.
 *
 * The pack id is opaque on purpose. A file called `theyutes.json` would publish the passphrase in
 * the filename, which is the one mistake this whole arrangement exists to avoid.
 */

/** scrypt, at parameters chosen for a one-off unlock rather than a login. N=2^16 with r=8 is ~64 MB
 *  and ~100ms on an M-series Mac; a user types a word once and waits for eight of these in
 *  sequence, which is a fifth of a second in total and unnoticeable behind a button. */
export const EGG_KDF = { N: 65_536, r: 8, p: 1, keyBytes: 32 } as const;

/** One sealed pack, as it sits in the repository. */
export const SealedEggPackSchema = z.object({
  /** Opaque. Never the group's name, never the passphrase. */
  id: z.string().min(1).max(64),
  v: z.literal(1),
  /** base64, 16 bytes. Per pack, so two groups with the same passphrase still differ. */
  salt: z.string().min(1),
  /** base64, 12 bytes — AES-GCM. */
  iv: z.string().min(1),
  /** base64: ciphertext ‖ 16-byte tag. */
  ct: z.string().min(1),
});
export type SealedEggPack = z.infer<typeof SealedEggPackSchema>;

/** A run label, in the shape `run-label.ts` already uses. Duplicated here rather than imported
 *  because a pack is data on disk: its shape has to be validated at the boundary, and a type from
 *  the renderer is not a validator. */
export const EggLabelSchema = z.object({ present: z.string().min(1).max(60), past: z.string().min(1).max(60) });

/** What is inside a pack once it is open. */
export const EggPackSchema = z.object({
  /** What the group is called, for the row in Settings that says what you unlocked. */
  group: z.string().min(1).max(60),
  /** The working-label pairs this group adds — "Asking Someone" / "Asked Someone", with the group's
   *  own names in place of Someone. No real example here: this file is public. */
  labels: z.array(EggLabelSchema).min(1).max(60),
  /** Optional extra lines for the hero greeting, in this group's own voice. */
  greetings: z.array(z.string().min(1).max(120)).max(20).default([]),
});
export type EggPack = z.infer<typeof EggPackSchema>;

/** An unlocked pack, as the renderer sees it: the contents plus the id it was opened from, so a
 *  group can be forgotten again without the passphrase having to be typed a second time. */
export const UnlockedEggPackSchema = EggPackSchema.extend({ id: z.string() });
export type UnlockedEggPack = z.infer<typeof UnlockedEggPackSchema>;
