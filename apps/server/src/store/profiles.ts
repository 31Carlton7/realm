import type { Db } from "../db/database";
import { newId, type Profile } from "@realm/contracts";
import { NotFoundError, RpcError, now } from "./rows";

type Row = { id: string; name: string; icon: string; color: string; sort_order: number; browser_partition: string; created_at: number; updated_at: number };
const toProfile = (r: Row): Profile => ({ id: r.id, name: r.name, icon: r.icon, color: r.color, sortOrder: r.sort_order, browserPartition: r.browser_partition, createdAt: r.created_at, updatedAt: r.updated_at });

/** The partition every browser pane used before profiles had their own (migration v37). Whichever
 *  profile holds it holds the sign-ins made before then. */
export const SHARED_BROWSER_PARTITION = "persist:browser";

/** A profile's own partition, for every profile but the one that inherited the shared jar. */
export const browserPartitionFor = (profileId: string): string => `${SHARED_BROWSER_PARTITION}-${profileId}`;

/** A name as a person typed it, or a refusal: a profile called "   " is a row nobody can find. */
function cleanName(name: string): string {
  const n = name.trim();
  if (n === "") throw new RpcError("INVALID_NAME", "A profile needs a name.");
  return n;
}

export class ProfilesStore {
  constructor(private db: Db) {}
  list(): Profile[] {
    return (this.db.prepare("SELECT * FROM profiles ORDER BY sort_order, created_at").all() as Row[]).map(toProfile);
  }
  get(id: string): Profile | null {
    const r = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as Row | undefined;
    return r ? toProfile(r) : null;
  }
  /** A new profile, last in the order. The very first profile of a home takes the shared partition —
   *  on a fresh install that is the jar nothing has used yet, and on an old one migration v37 has
   *  already given it away, so this branch never runs there. */
  create(input: { name: string; icon: string; color: string }): Profile {
    const name = cleanName(input.name);
    const { m, n } = this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m, COUNT(*) AS n FROM profiles").get() as { m: number; n: number };
    const id = newId(); const t = now();
    const partition = n === 0 ? SHARED_BROWSER_PARTITION : browserPartitionFor(id);
    this.db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, browser_partition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, name, input.icon, input.color, m + 1, partition, t, t);
    return this.get(id)!;
  }
  /** Name, icon, colour and place. Never the partition — see `Profile.browserPartition`. */
  update(input: { id: string; name?: string; icon?: string; color?: string; sortOrder?: number }): Profile {
    const cur = this.get(input.id); if (!cur) throw new NotFoundError("profile", input.id);
    this.db.prepare("UPDATE profiles SET name = ?, icon = ?, color = ?, sort_order = ?, updated_at = ? WHERE id = ?")
      .run(input.name === undefined ? cur.name : cleanName(input.name), input.icon ?? cur.icon, input.color ?? cur.color, input.sortOrder ?? cur.sortOrder, now(), input.id);
    return this.get(input.id)!;
  }
  /** What goes with a profile if it is deleted: its spaces, and every session in them. */
  usage(id: string): { spaces: number; sessions: number } {
    if (!this.get(id)) throw new NotFoundError("profile", id);
    const spaces = (this.db.prepare("SELECT COUNT(*) AS n FROM spaces WHERE profile_id = ?").get(id) as { n: number }).n;
    const sessions = (this.db.prepare("SELECT COUNT(*) AS n FROM sessions s JOIN spaces sp ON sp.id = s.space_id WHERE sp.profile_id = ?").get(id) as { n: number }).n;
    return { spaces, sessions };
  }
  /** The row and, by cascade, everything scoped to it. The last profile cannot go: every space needs
   *  one, so a home with none could not hold any work at all. */
  delete(id: string): void {
    if (!this.get(id)) throw new NotFoundError("profile", id);
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM profiles").get() as { n: number };
    if (n <= 1) throw new RpcError("LAST_PROFILE", "This is the only profile, so it can't be deleted. Make another profile first.");
    this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  }
}
