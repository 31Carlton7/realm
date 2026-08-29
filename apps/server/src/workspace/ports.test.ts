import { describe, expect, it, beforeEach } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "../db/database";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { EnvironmentsStore } from "../store/environments";
import { PORT_BLOCK_COUNT, PORT_BLOCK_SIZE, PORT_POOL_END, PORT_POOL_START, PortAllocator, portEnv, probePort } from "./ports";

let db: Db; let home: string; let spaces: SpacesStore; let envs: EnvironmentsStore;
let spaceIds: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "realm-ports-"));
  db = openDatabase(join(home, "realm.db"));
  const p = new ProfilesStore(db).create({ name: "P", icon: "x", color: "#000" });
  spaces = new SpacesStore(db, home);
  envs = new EnvironmentsStore(db);
  spaceIds = ["a", "b", "c"].map((n) => spaces.create({ profileId: p.id, name: n, icon: "folder" }).id);
});

/** Every port free, so allocation is decided purely by the database. */
const allFree = () => new PortAllocator(db, { probe: async () => true });
const mk = (spaceIdx = 0, path = `/tmp/wt-${Math.random()}`) =>
  envs.create({ spaceId: spaceIds[spaceIdx]!, path, kind: "worktree" });

describe("portEnv", () => {
  it("exports the block as REALM_* plus the PORT the ecosystem already reads", () => {
    expect(portEnv({ id: "E1", portBlockStart: 41000 })).toEqual({
      REALM_ENVIRONMENT_ID: "E1", REALM_PORT_BASE: "41000", REALM_PORT_COUNT: "10", REALM_PORT_END: "41009", PORT: "41000",
    });
  });
  it("exports the block's last port, not its size, as REALM_PORT_END", () => {
    expect(portEnv({ id: "E1", portBlockStart: 41230 }).REALM_PORT_END).toBe(String(41230 + PORT_BLOCK_SIZE - 1));
  });
  it("exports no ports at all for an environment that never got a block", () => {
    expect(portEnv({ id: "E1", portBlockStart: null })).toEqual({ REALM_ENVIRONMENT_ID: "E1" });
  });
});

describe("PortAllocator", () => {
  it("hands out the first block of the pool, and persists it on the row", async () => {
    const env = mk();
    expect(await allFree().ensureBlock(env.id)).toBe(PORT_POOL_START);
    expect(envs.get(env.id)!.portBlockStart).toBe(PORT_POOL_START);
  });

  // MUTANT: reallocate on every call (drop the early return, or drop the column read) and the block
  // stops being stable — a dev server left running in a worktree loses its port on relaunch.
  it("survives a restart: a fresh allocator reads the block back rather than reissuing", async () => {
    const env = mk();
    const first = await allFree().ensureBlock(env.id);
    db.close();
    const reopened = openDatabase(join(home, "realm.db"));
    const after = new PortAllocator(reopened, { probe: async () => true });
    expect(await after.ensureBlock(env.id)).toBe(first);
    // …and a NEW environment created after the restart does not get the same block.
    const other = new EnvironmentsStore(reopened).create({ spaceId: spaceIds[1]!, path: "/tmp/other", kind: "worktree" });
    expect(await after.ensureBlock(other.id)).not.toBe(first);
    reopened.close();
  });

  it("is idempotent within one process", async () => {
    const env = mk(); const a = allFree();
    expect(await a.ensureBlock(env.id)).toBe(await a.ensureBlock(env.id));
  });

  // MUTANT: two environments allocated overlapping blocks.
  it("never hands two environments the same block", async () => {
    const a = allFree();
    const starts = new Set<number>();
    for (let i = 0; i < 12; i++) {
      const start = await a.ensureBlock(mk(i % 3).id);
      expect(start).not.toBeNull();
      expect(starts.has(start!), `block ${start} handed out twice`).toBe(false);
      starts.add(start!);
    }
    expect(starts.size).toBe(12);
  });

  it("hands out blocks that do not overlap as ranges, not merely as distinct starts", async () => {
    const a = allFree();
    const used = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const start = (await a.ensureBlock(mk(i % 3).id))!;
      for (let p = start; p < start + PORT_BLOCK_SIZE; p++) {
        expect(used.has(p), `port ${p} is in two blocks`).toBe(false);
        used.add(p);
      }
    }
  });

  it("concurrent allocations for different environments do not collide", async () => {
    const a = allFree();
    const ids = Array.from({ length: 8 }, (_, i) => mk(i % 3).id);
    const starts = await Promise.all(ids.map((id) => a.ensureBlock(id)));
    expect(new Set(starts).size).toBe(starts.length);
  });

  it("concurrent allocations for the SAME environment settle on one block", async () => {
    const a = allFree(); const env = mk();
    const [x, y, z] = await Promise.all([a.ensureBlock(env.id), a.ensureBlock(env.id), a.ensureBlock(env.id)]);
    expect(y).toBe(x); expect(z).toBe(x);
    expect(envs.get(env.id)!.portBlockStart).toBe(x);
  });

  // The invariant is the schema's, not the allocator's care — a second writer cannot duplicate a
  // start even by going round the class.
  it("the database itself rejects a duplicate block", () => {
    const one = mk(); const two = mk();
    db.prepare("UPDATE environments SET port_block_start = ? WHERE id = ?").run(41000, one.id);
    expect(() => db.prepare("UPDATE environments SET port_block_start = ? WHERE id = ?").run(41000, two.id)).toThrow();
  });

  it("skips a block any of whose ports is already in use on the machine", async () => {
    // The whole first block is busy; the second's last port is busy; the third is clear.
    const busy = new Set<number>([
      ...Array.from({ length: PORT_BLOCK_SIZE }, (_, i) => PORT_POOL_START + i),
      PORT_POOL_START + 2 * PORT_BLOCK_SIZE - 1,
    ]);
    const a = new PortAllocator(db, { probe: async (p) => !busy.has(p) });
    expect(await a.ensureBlock(mk().id)).toBe(PORT_POOL_START + 2 * PORT_BLOCK_SIZE);
  });

  it("really does detect a listening socket", async () => {
    const server: Server = createServer();
    const port: number = await new Promise((r) => server.listen({ port: 0, host: "127.0.0.1" }, () => r((server.address() as { port: number }).port)));
    try {
      expect(await probePort(port)).toBe(false);
    } finally { await new Promise((r) => server.close(() => r(null))); }
    expect(await probePort(port)).toBe(true);
  });

  it("degrades to no block, rather than failing, when the pool is exhausted", async () => {
    // Every block already claimed by rows that are not ours.
    const filler = mk(0, "/tmp/filler");
    for (let n = 0; n < PORT_BLOCK_COUNT; n++) {
      db.prepare("INSERT INTO environments (id, space_id, path, branch, kind, port_block_start, created_at, updated_at) VALUES (?, ?, ?, NULL, 'worktree', ?, 0, 0)")
        .run(`F${String(n).padStart(25, "0")}`, spaceIds[0], `/tmp/f${n}`, PORT_POOL_START + n * PORT_BLOCK_SIZE);
    }
    expect(await allFree().ensureBlock(filler.id)).toBeNull();
    expect(envs.get(filler.id)!.portBlockStart).toBeNull();
    // Nothing threw, and the environment is still usable — it simply exports no PORT.
    expect(portEnv(envs.get(filler.id)!).PORT).toBeUndefined();
  });

  it("degrades to no block when every candidate port is occupied", async () => {
    const a = new PortAllocator(db, { probe: async () => false });
    expect(await a.ensureBlock(mk().id)).toBeNull();
  });

  it("stays inside the declared pool", async () => {
    const a = allFree();
    for (let i = 0; i < 5; i++) {
      const start = (await a.ensureBlock(mk(i % 3).id))!;
      expect(start).toBeGreaterThanOrEqual(PORT_POOL_START);
      expect(start + PORT_BLOCK_SIZE - 1).toBeLessThanOrEqual(PORT_POOL_END);
    }
  });

  it("returns null for an environment that no longer exists", async () => {
    expect(await allFree().ensureBlock("01HZZZZZZZZZZZZZZZZZZZZZZZ")).toBeNull();
  });
});
