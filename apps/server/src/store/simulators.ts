import type { Db } from "../db/database";
import type { Simulator, SimulatorPlatform } from "@realm/contracts";
import { now } from "./rows";

type Row = { id: string; space_id: string; name: string; udid: string | null; platform: string; physical: number; created_at: number; updated_at: number };

const toSimulator = (r: Row): Simulator =>
  ({
    id: r.id, spaceId: r.space_id, name: r.name, udid: r.udid,
    // Narrowed here rather than trusted: the column is TEXT, and a row written by a future version
    // with a platform this build has never heard of must read as something this build can reach,
    // not crash a list. `ios` is what every row predating the column already is.
    platform: r.platform === "android" ? "android" : "ios",
    physical: r.physical === 1,
    createdAt: r.created_at, updatedAt: r.updated_at,
  });

/** The durable half of a simulator pane: which device it is for. `MachinesStore` without the
 *  secrets, the endpoint or the port — see the v28 migration for why there is so little here. */
export class SimulatorsStore {
  constructor(private db: Db) {}

  insert(input: { id: string; spaceId: string; name: string; udid: string | null; platform?: SimulatorPlatform; physical?: boolean }): Simulator {
    const t = now();
    const platform: SimulatorPlatform = input.platform ?? "ios";
    const physical = input.physical === true;
    this.db.prepare("INSERT INTO simulators (id, space_id, name, udid, platform, physical, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.id, input.spaceId, input.name, input.udid, platform, physical ? 1 : 0, t, t);
    return { ...input, platform, physical, createdAt: t, updatedAt: t };
  }

  get(id: string): Simulator | null {
    const r = this.db.prepare("SELECT * FROM simulators WHERE id = ?").get(id) as Row | undefined;
    return r ? toSimulator(r) : null;
  }

  /** A space's simulators, oldest first — the sidebar's order. */
  list(spaceId: string): Simulator[] {
    return (this.db.prepare("SELECT * FROM simulators WHERE space_id = ? ORDER BY created_at ASC").all(spaceId) as Row[]).map(toSimulator);
  }

  all(): Simulator[] {
    return (this.db.prepare("SELECT * FROM simulators").all() as Row[]).map(toSimulator);
  }

  /** `platform` and `physical` move with `udid`, because they have to: the three are one fact about
   *  one device, and a row left claiming `ios` while pointed at an AVD is a row that reaches for
   *  `simctl` — as one left claiming a simulator while pointed at a phone would. */
  update(id: string, patch: { name?: string; udid?: string | null; platform?: SimulatorPlatform; physical?: boolean }): Simulator | null {
    const row = this.get(id);
    if (!row) return null;
    const next = {
      name: patch.name ?? row.name,
      udid: patch.udid === undefined ? row.udid : patch.udid,
      platform: patch.platform ?? row.platform,
      physical: patch.physical ?? row.physical,
    };
    this.db.prepare("UPDATE simulators SET name = ?, udid = ?, platform = ?, physical = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.udid, next.platform, next.physical ? 1 : 0, now(), id);
    return this.get(id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM simulators WHERE id = ?").run(id);
  }
}
