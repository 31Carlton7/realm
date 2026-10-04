/**
 * What Electron main knows about profiles (Plan 27 Phase 2): each one's name and browser partition,
 * asked of realm-server, which owns them.
 *
 * Main needs three answers it cannot make up. Which partition a profile's panes use — every profile
 * has its own cookie jar now, and the first profile kept the jar every pane used to share, which is a
 * fact stored on the server rather than derived here. Which profile inherits the saved sign-ins from
 * before they were a profile's own (`SecretStore`'s `defaultProfileId`). And a profile's name, for the
 * confirm and the receipts that say whose browser is being cleared or shared into.
 *
 * Electron-free, like `secret-store.ts`: the server call arrives through `fetch`, so what this decides
 * — that a profile which disappears is noticed, that a malformed answer names no partition — dies in
 * a unit test.
 */

/** The partition every browser pane used before profiles had their own. Whichever profile holds it
 *  holds the sign-ins made before then (migration v37). */
export const SHARED_BROWSER_PARTITION = "persist:browser";

export type ProfileFacts = { id: string; name: string; browserPartition: string };

/** A partition main will hand a pane: the shared one, or a profile's own. Anything else — an empty
 *  string, a non-persistent name, a path — is a server bug, and a pane is better with no view than
 *  with a jar nobody chose. */
export const isBrowserPartition = (p: unknown): p is string =>
  typeof p === "string" && (p === SHARED_BROWSER_PARTITION || /^persist:browser-[0-9A-Za-z]{1,64}$/.test(p));

function parse(rows: unknown): ProfileFacts[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const p = r as Record<string, unknown> | null;
    return p && typeof p.id === "string" && typeof p.name === "string" && isBrowserPartition(p.browserPartition)
      ? [{ id: p.id, name: p.name, browserPartition: p.browserPartition }]
      : [];
  });
}

export class ProfileDirectory {
  private profiles: ProfileFacts[] | null = null;
  private asking: Promise<readonly ProfileFacts[]> | null = null;

  constructor(private readonly d: {
    /** `profiles.list`, on whichever socket main has. Rejects when realm-server cannot be reached. */
    fetch(): Promise<unknown>;
    /** A profile that was in the last answer and is not in this one — it was deleted. Its panes, its
     *  partition's data and its sign-ins are the caller's to put away. Never fired by the FIRST
     *  answer, which has nothing to compare with. */
    onRemoved?(profile: ProfileFacts): void;
  }) {}

  /** The last answer, or nothing before the first. */
  known(): readonly ProfileFacts[] { return this.profiles ?? []; }

  get(id: string): ProfileFacts | null { return this.known().find((p) => p.id === id) ?? null; }

  /** The profile that kept the shared partition, which is the one that inherits rows from before
   *  profiles were separate. Null until the server has answered, and if that profile was deleted. */
  defaultProfileId(): string | null {
    return this.known().find((p) => p.browserPartition === SHARED_BROWSER_PARTITION)?.id ?? null;
  }

  /** Ask again — on `profiles.changed`, and when a profile is asked for that the last answer did not
   *  have. Concurrent askers share one request. A failed ask keeps the last answer. */
  refresh(): Promise<readonly ProfileFacts[]> {
    this.asking ??= this.d.fetch().then((rows) => {
      const next = parse(rows);
      const before = this.profiles;
      this.profiles = next;
      if (before) for (const gone of before.filter((p) => !next.some((n) => n.id === p.id))) this.d.onRemoved?.(gone);
      return next;
    }, () => this.known()).finally(() => { this.asking = null; });
    return this.asking;
  }

  /** One profile, asking the server once when the last answer did not have it — a profile made a
   *  moment ago, before its `profiles.changed` arrived. */
  async resolve(id: string): Promise<ProfileFacts | null> {
    return this.get(id) ?? (await this.refresh()).find((p) => p.id === id) ?? null;
  }
}
