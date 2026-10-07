import type { SettingsStore } from "../store/settings";

const allowedMachinesKey = (spaceId: string): string => `machine.allowedMachines:${spaceId}`;

/**
 * The machines an agent may drive in a space without being asked again (Plan 25 W4).
 *
 * **Per space**, for the reason `ComputerAppAllowlist` gives and which applies unchanged here:
 * `realm-vm` is off until a space turns it on, and a list scoped wider than its own switch would
 * mean a space that was just given machine control silently inheriting approvals made somewhere
 * else. Entries are machine ids, so an entry means exactly what the session grant it graduates from
 * meant — approving the Mac in the studio must not read as approving a cloud sandbox.
 *
 * There is deliberately **no forbidden set**, and its absence is the interesting difference from the
 * computer allowlist. That one hard-refuses Realm's own windows, System Settings, Keychain and a
 * terminal, because those are where the permissions that permit it live and where a password is
 * typed. A machine has no such list to keep: every machine here is one the user added themselves, by
 * address, and there is no equivalent of "System Settings" among them — a remote Mac's own System
 * Settings is on the far side of a screen Realm can only see as pixels. Shipping an empty constant
 * to mirror the other class would be a dead check that reads as a guarantee.
 *
 * What DOES carry over is that the id is checked at every door: a settings row is user-editable JSON
 * on disk, so `allows` re-reads rather than trusting anything cached.
 */
export class MachineAllowlist {
  constructor(private readonly d: { settings: Pick<SettingsStore, "getIds" | "set"> }) {}

  /** The space's list, as the user should see it. */
  list(spaceId: string): string[] {
    return this.d.settings.getIds(allowedMachinesKey(spaceId));
  }

  /** May this space drive this machine without a card? */
  allows(spaceId: string, machineId: string): boolean {
    if (!machineId) return false;
    return this.d.settings.getIds(allowedMachinesKey(spaceId)).includes(machineId);
  }

  /** Graduate one machine from a session grant to a standing one. */
  add(spaceId: string, machineId: string): void {
    if (!machineId) return;
    this.replace(spaceId, [...this.list(spaceId), machineId]);
  }

  /** Set the whole list, and return it as stored — so a caller renders what was persisted rather
   *  than what it sent. Sorted and de-duplicated to keep the row diff-stable. */
  replace(spaceId: string, machineIds: string[]): string[] {
    const next = [...new Set(machineIds.filter((id) => id.trim().length > 0))].sort();
    this.d.settings.set(allowedMachinesKey(spaceId), next);
    return next;
  }
}
