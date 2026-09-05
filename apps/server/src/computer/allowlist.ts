import { COMPUTER_FORBIDDEN_BUNDLE_IDS } from "@realm/contracts";
import type { SettingsStore } from "../store/settings";

const allowedAppsKey = (spaceId: string): string => `computer.allowedApps:${spaceId}`;

const FORBIDDEN: ReadonlySet<string> = new Set(COMPUTER_FORBIDDEN_BUNDLE_IDS);

/**
 * The applications an agent may drive in a space without being asked again.
 *
 * **Per space**, because that is where the feature is switched on: `realm-computer` is the one
 * provider that stays off until a space enables it, and a list scoped wider than its own switch
 * would mean a space that was just given computer use silently inheriting approvals made somewhere
 * else. Global would make approving TextEdit once license every space that will ever exist. Profile
 * would be a new scope for one feature — nothing else in Realm keeps settings there.
 *
 * Entries are bundle ids, so an entry means exactly what the session grant it graduates from means.
 * The permission card is keyed on the bundle id for the same reason: approving TextEdit must not
 * read as approving Mail.
 *
 * The forbidden list wins over this one at every door. `allows` refuses a forbidden id whatever is
 * stored; neither `add` nor `replace` will store one; and `list` drops one on the way out. That is
 * three checks for one rule because a settings row is user-editable JSON on disk — a value that was
 * never written through this class can still be read through it.
 */
export class ComputerAppAllowlist {
  constructor(private readonly d: { settings: Pick<SettingsStore, "getIds" | "set"> }) {}

  /** The space's list, as the user should see it. */
  list(spaceId: string): string[] {
    return this.d.settings.getIds(allowedAppsKey(spaceId)).filter((id) => !FORBIDDEN.has(id));
  }

  /** May this space drive this application without a card? */
  allows(spaceId: string, bundleId: string): boolean {
    if (!bundleId || FORBIDDEN.has(bundleId)) return false;
    return this.d.settings.getIds(allowedAppsKey(spaceId)).includes(bundleId);
  }

  /** Graduate one app from a session grant to a standing one. */
  add(spaceId: string, bundleId: string): void {
    if (!bundleId || FORBIDDEN.has(bundleId)) return;
    this.replace(spaceId, [...this.list(spaceId), bundleId]);
  }

  /**
   * Set the whole list, and return it as stored — so a caller renders what was persisted rather than
   * what it sent, the way the usage budget re-parses on write. Sorted and de-duplicated to keep the
   * row diff-stable.
   */
  replace(spaceId: string, bundleIds: string[]): string[] {
    const next = [...new Set(bundleIds.filter((id) => id.trim().length > 0 && !FORBIDDEN.has(id)))].sort();
    this.d.settings.set(allowedAppsKey(spaceId), next);
    return next;
  }
}
