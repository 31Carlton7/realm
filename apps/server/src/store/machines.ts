import type { Db } from "../db/database";
import type { Machine, MachineSource, VncEndpoint } from "@realm/contracts";
import { now } from "./rows";

type Row = {
  id: string; space_id: string; name: string; source: string;
  endpoint_json: string | null; password_sealed: string | null; headers_sealed: string | null; ws_port: number | null;
  created_at: number; updated_at: number;
};

/**
 * A stored endpoint back into the shape the contract names.
 *
 * Anything unparseable degrades to null rather than throwing: a row written by a newer build, or one
 * a hand-edited database has mangled, must still LIST. A machine that cannot be reached is a machine
 * the pane says it cannot reach; a machine that makes `machines.list` throw takes the whole space's
 * sidebar with it.
 */
function toEndpoint(json: string | null): VncEndpoint | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { host?: unknown; port?: unknown; transport?: unknown; path?: unknown };
    if (typeof v?.host !== "string" || v.host === "") return null;
    const port = typeof v.port === "number" && Number.isInteger(v.port) && v.port > 0 && v.port < 65536 ? v.port : 5900;
    /* `transport` and `path` were added after the first rows were written (Plan 25 W3's sandbox
       support), so a row from before them has neither — and `tcp` on 5900 with websockify's own path
       is exactly what those rows meant. Defaulted rather than rejected: a machine that stopped
       listing because a field was added later is the worst possible upgrade. */
    const transport = v.transport === "tls" || v.transport === "ws" || v.transport === "wss" ? v.transport : "tcp";
    const path = typeof v.path === "string" && v.path !== "" ? v.path : "/websockify";
    return { transport, host: v.host, port, path };
  } catch { return null; }
}

const toMachine = (r: Row): Machine => ({
  id: r.id, spaceId: r.space_id, name: r.name, source: r.source as MachineSource,
  endpoint: toEndpoint(r.endpoint_json),
  // The BOOLEAN, never the box. Nothing above this line has a reason to hold a sealed password, and
  // a `Machine` travels over RPC to every client — so the type it is mapped into has no field for
  // one. `sealedPassword` below is the single deliberate way back to it, and it is server-only.
  hasPassword: r.password_sealed !== null,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

export class MachinesStore {
  constructor(private db: Db) {}

  insert(input: { id: string; spaceId: string; name: string; source: MachineSource; endpoint: VncEndpoint | null; sealedPassword: string | null; sealedHeaders?: string | null }): Machine {
    const t = now();
    this.db.prepare("INSERT INTO machines (id, space_id, name, source, endpoint_json, password_sealed, headers_sealed, ws_port, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)")
      .run(input.id, input.spaceId, input.name, input.source, input.endpoint ? JSON.stringify(input.endpoint) : null, input.sealedPassword, input.sealedHeaders ?? null, t, t);
    return { id: input.id, spaceId: input.spaceId, name: input.name, source: input.source, endpoint: input.endpoint, hasPassword: input.sealedPassword !== null, createdAt: t, updatedAt: t };
  }

  get(id: string): Machine | null {
    const r = this.db.prepare("SELECT * FROM machines WHERE id = ?").get(id) as Row | undefined;
    return r ? toMachine(r) : null;
  }

  /** A space's machines, oldest first — the sidebar's order and `vm_list`'s. */
  list(spaceId: string): Machine[] {
    return (this.db.prepare("SELECT * FROM machines WHERE space_id = ? ORDER BY created_at").all(spaceId) as Row[]).map(toMachine);
  }

  /** Every machine, for `restoreAll`'s port sweep — which has to reach rows in spaces nobody opened. */
  all(): Machine[] {
    return (this.db.prepare("SELECT * FROM machines ORDER BY created_at").all() as Row[]).map(toMachine);
  }

  /**
   * The sealed box, for the one caller that authenticates with it.
   *
   * A separate method rather than a field on `Machine`, and the separation is the point: `Machine` is
   * what `machines.list` returns to every connected client, and a shape with a secret in it is one
   * mistake away from being logged, broadcast or handed to an agent. Nothing can reach a password by
   * accident here; a caller has to ask for it by name.
   */
  sealedPassword(id: string): string | null {
    const r = this.db.prepare("SELECT password_sealed FROM machines WHERE id = ?").get(id) as { password_sealed: string | null } | undefined;
    return r?.password_sealed ?? null;
  }

  /** The sealed upgrade headers, for the one caller that dials with them. Separate from the
   *  password for the reason migration v27 gives: they authenticate to different things. */
  sealedHeaders(id: string): string | null {
    const r = this.db.prepare("SELECT headers_sealed FROM machines WHERE id = ?").get(id) as { headers_sealed: string | null } | undefined;
    return r?.headers_sealed ?? null;
  }

  update(id: string, patch: { name?: string; source?: MachineSource; endpoint?: VncEndpoint | null; sealedPassword?: string | null; sealedHeaders?: string | null }): Machine | null {
    const cur = this.get(id);
    if (!cur) return null;
    // `sealedPassword` is three-valued on the way in and the distinction matters: absent leaves the
    // stored one alone, `null` clears it, a string replaces it. Collapsing absent and null would
    // silently drop the password on any edit that only renamed the machine.
    const sealed = patch.sealedPassword === undefined ? this.sealedPassword(id) : patch.sealedPassword;
    const headers = patch.sealedHeaders === undefined ? this.sealedHeaders(id) : patch.sealedHeaders;
    const endpoint = patch.endpoint === undefined ? cur.endpoint : patch.endpoint;
    this.db.prepare("UPDATE machines SET name = ?, source = ?, endpoint_json = ?, password_sealed = ?, headers_sealed = ?, updated_at = ? WHERE id = ?")
      .run(patch.name ?? cur.name, patch.source ?? cur.source, endpoint ? JSON.stringify(endpoint) : null, sealed, headers, now(), id);
    return this.get(id);
  }

  /** The port this machine's proxy is listening on for this run, or null when it is not running. */
  setWsPort(id: string, port: number | null): void {
    this.db.prepare("UPDATE machines SET ws_port = ? WHERE id = ?").run(port, id);
  }

  wsPort(id: string): number | null {
    const r = this.db.prepare("SELECT ws_port FROM machines WHERE id = ?").get(id) as { ws_port: number | null } | undefined;
    return r?.ws_port ?? null;
  }

  /**
   * Every recorded port, forgotten.
   *
   * Called at startup, before anything starts. A port recorded against a process that died with the
   * last run is a lie, and worse than a lie: the UNIQUE index would refuse to reissue it, so a
   * machine that crashed with Realm could never be given its own port back.
   */
  clearAllWsPorts(): void {
    this.db.prepare("UPDATE machines SET ws_port = NULL WHERE ws_port IS NOT NULL").run();
  }

  /** Idempotent, like `BrowsersStore.delete`. */
  delete(id: string): void {
    this.db.prepare("DELETE FROM machines WHERE id = ?").run(id);
  }
}
