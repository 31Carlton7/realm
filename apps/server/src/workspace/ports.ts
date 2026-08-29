import { createServer } from "node:net";
import type { Environment } from "@realm/contracts";
import type { Db } from "../db/database";
import { now } from "../store/rows";

/**
 * A contiguous block of ports reserved for one environment (Conductor's pattern: a base plus nine),
 * so three agents running `pnpm dev` in three worktrees do not all want `:3000`.
 *
 * The pool sits at 41000–42999: above every common dev port (3000/4200/5173/8080/8787), inside the
 * IANA registered range, and below macOS's ephemeral range (49152+) so the kernel never hands one of
 * these to an unrelated socket behind our back.
 */
export const PORT_BLOCK_SIZE = 10;
export const PORT_POOL_START = 41_000;
export const PORT_BLOCK_COUNT = 200;
export const PORT_POOL_END = PORT_POOL_START + PORT_BLOCK_COUNT * PORT_BLOCK_SIZE - 1;

/** Resolves true when nothing is listening on `port`. Injectable: tests must not depend on which
 *  ports happen to be free on the machine running them. */
export type PortProbe = (port: number) => Promise<boolean>;

/** Bind-and-release on 127.0.0.1. A server bound to 0.0.0.0 also makes this fail (EADDRINUSE),
 *  which is what we want — the question is "could a dev server take this", not "is loopback free". */
export const probePort: PortProbe = (port) =>
  new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen({ port, host: "127.0.0.1", exclusive: true }, () => s.close(() => resolve(true)));
  });

/**
 * The environment variables an agent or terminal in this environment is spawned with.
 *
 * `PORT` is set as well as the `REALM_*` names because it is the one variable the ecosystem already
 * agrees on (Next, Express, most `npm start` scripts read it) — setting only Realm-specific names
 * would mean the feature works exactly for the projects that had already heard of Realm.
 *
 * An environment with no block (a pool that ran dry) gets its id and nothing else: the caller falls
 * back to whatever it did before Realm existed, which is the status quo, not a regression.
 */
export function portEnv(env: Pick<Environment, "id" | "portBlockStart">): Record<string, string> {
  const vars: Record<string, string> = { REALM_ENVIRONMENT_ID: env.id };
  if (env.portBlockStart === null) return vars;
  vars.REALM_PORT_BASE = String(env.portBlockStart);
  vars.REALM_PORT_COUNT = String(PORT_BLOCK_SIZE);
  vars.REALM_PORT_END = String(env.portBlockStart + PORT_BLOCK_SIZE - 1);
  vars.PORT = String(env.portBlockStart);
  return vars;
}

/**
 * Hands each environment a block, once, and remembers it in `environments.port_block_start`.
 *
 * Three properties, in the order they matter:
 *
 *  - **No two environments overlap.** Starts are `PORT_POOL_START + n * PORT_BLOCK_SIZE`, so blocks
 *    are disjoint by construction, and `environments_port_block` is a UNIQUE index (migration v6):
 *    two allocators racing cannot both win, because the second UPDATE throws rather than duplicating.
 *    The invariant lives in the schema, not in this class's care.
 *  - **It survives restart.** The block is a column. `ensureBlock` on an environment that already
 *    has one is a read; nothing is ever reallocated, so a dev server left running in a worktree
 *    still owns its port after a relaunch.
 *  - **It avoids ports the machine is already using**, by probing each port of a candidate block
 *    (bailing at the first busy one) before taking it. This is a courtesy, not a guarantee — a
 *    process can start on one of our ports a moment later; the database is the allocator.
 *
 * Exhaustion: `ensureBlock` returns null and the environment keeps a null column. Nothing fails —
 * a worktree that cannot have a port block is still a worktree — but the spawned processes get no
 * `PORT`, and 200 live blocks means something is leaking, so it is logged every time.
 */
export class PortAllocator {
  private probe: PortProbe;
  /** One allocation per environment at a time; concurrent callers await the same promise. */
  private inflight = new Map<string, Promise<number | null>>();
  constructor(private db: Db, opts: { probe?: PortProbe } = {}) {
    this.probe = opts.probe ?? probePort;
  }

  ensureBlock(environmentId: string): Promise<number | null> {
    const pending = this.inflight.get(environmentId);
    if (pending) return pending;
    const p = this.allocate(environmentId).finally(() => this.inflight.delete(environmentId));
    this.inflight.set(environmentId, p);
    return p;
  }

  private async allocate(environmentId: string): Promise<number | null> {
    const row = this.db.prepare("SELECT port_block_start FROM environments WHERE id = ?").get(environmentId) as { port_block_start: number | null } | undefined;
    if (!row) return null; // deleted underneath us; the caller's own lookup reports that
    if (row.port_block_start !== null) return row.port_block_start;

    const taken = new Set((this.db.prepare("SELECT port_block_start AS s FROM environments WHERE port_block_start IS NOT NULL").all() as { s: number }[]).map((r) => r.s));
    for (let n = 0; n < PORT_BLOCK_COUNT; n++) {
      const start = PORT_POOL_START + n * PORT_BLOCK_SIZE;
      if (taken.has(start)) continue;
      if (!(await this.blockIsFree(start))) continue;
      // `AND port_block_start IS NULL` keeps a concurrent winner's block; the UNIQUE index rejects a
      // start another environment took while we were probing. Either way, try the next candidate.
      try {
        const res = this.db.prepare("UPDATE environments SET port_block_start = ?, updated_at = ? WHERE id = ? AND port_block_start IS NULL").run(start, now(), environmentId);
        if (res.changes === 0) {
          const again = this.db.prepare("SELECT port_block_start FROM environments WHERE id = ?").get(environmentId) as { port_block_start: number | null } | undefined;
          return again?.port_block_start ?? null;
        }
        return start;
      } catch { taken.add(start); }
    }
    console.error(`[ports] pool exhausted (${PORT_BLOCK_COUNT} blocks, ${PORT_POOL_START}-${PORT_POOL_END}); ${environmentId} gets no port block`);
    return null;
  }

  /** Every port in the block must be free. Sequential and short-circuiting: a block whose first port
   *  is busy costs one probe, and the common case (nothing listening) costs ten cheap binds once
   *  per environment for the life of the row. */
  private async blockIsFree(start: number): Promise<boolean> {
    for (let i = 0; i < PORT_BLOCK_SIZE; i++) if (!(await this.probe(start + i))) return false;
    return true;
  }
}
