import { newId, type Machine, type MachineSource, type MachineState, type VncEndpoint } from "@realm/contracts";
import type { Db } from "../db/database";
import type { RpcServer } from "../rpc/server";
import type { ItemsStore } from "../store/items";
import type { MachinesStore } from "../store/machines";
import type { SpacesStore } from "../store/spaces";
import { NotFoundError, RpcError } from "../store/rows";
import { machineSecretBox } from "./secret";
import { RfbDriver } from "./rfb-driver";
import type { MachineDriver } from "./driver";
import type { MachineTarget, MachineWsProxy } from "./ws-proxy";

/**
 * Owns a machine's pair — DB row + sidebar item — and its live state (Plan 25 W3).
 *
 * After `BrowserService`, with one addition it does not have: a machine's status is real and
 * changes, so this service holds it. In MEMORY, never in a column: status is a fact about a socket,
 * and no socket survives a restart. Every machine is `off` at boot, which is the only thing that is
 * true about a machine nobody has connected to yet.
 *
 * Only the `vnc` source is built. The others are refused BY NAME at `create`, rather than accepted
 * into a row that could never start — a machine in the sidebar that fails every time you press it
 * teaches a user that machines do not work.
 */
export type MachineServiceDeps = {
  db: Db; rpc: RpcServer; spaces: SpacesStore; items: ItemsStore; machines: MachinesStore; proxy: MachineWsProxy;
};

/** The sources this release can actually reach, and the sentence each of the others gets. */
const UNBUILT: Record<Exclude<MachineSource, "vnc">, string> = {
  qemu: "Realm cannot boot a local VM yet — connect a machine by address instead.",
  mac: "Realm cannot show this Mac's own screen yet — connect another machine by address instead.",
  container: "Realm cannot start a container yet — connect a machine by address instead.",
};

export class MachineService {
  /** Live status, keyed by machine id. Absent means `off`, so a machine nobody has touched costs a
   *  map entry of nothing and a restart starts everything in the one honest state. */
  private readonly state = new Map<string, MachineState>();

  /**
   * The AGENT's connection, one per machine, built on first use.
   *
   * A different socket from the human's, and that is the design rather than an accident: the pane's
   * RFB connection carries pixels to a canvas at whatever rate the screen changes, and this one
   * takes a still frame every few seconds and writes input. Neither can starve or evict the other.
   *
   * It also means an agent can drive a machine with no pane open at all — which is exactly when one
   * is most likely to be working.
   */
  private readonly drivers = new Map<string, MachineDriver>();

  constructor(private readonly d: MachineServiceDeps) {}

  /**
   * Row + item + one broadcast, inside one transaction. The split `terminals.create` makes: nothing
   * that can fail slowly — a socket, a port, a handshake — happens in here, so a half-created
   * machine is not a state the database can hold.
   */
  create(p: { spaceId: string; name: string; source: MachineSource; endpoint: VncEndpoint | null; password?: string | null }): { machineId: string; itemId: string; passwordStored: boolean } {
    const space = this.d.spaces.get(p.spaceId);
    if (!space) throw new NotFoundError("space", p.spaceId);
    if (p.source !== "vnc") throw new RpcError("INVALID_ARGUMENT", UNBUILT[p.source]);
    /* A machine with NO endpoint yet is legal, and it is what the session pane's button makes: the
       connect flow is the pane's own body rather than a sheet, so the pane — and therefore the item,
       and therefore the row — has to exist before there is an address to put in it. `start` is where
       the absence is refused, with a reason, which is the honest place for it. */

    // Sealed BEFORE the transaction opens, because it is the one step that can decide not to store
    // anything: with no key from the desktop app there is no ciphertext, and this refuses rather
    // than writing a login into realm.db in the clear.
    let sealed: string | null = null;
    let passwordStored = true;
    if (p.password) {
      sealed = machineSecretBox.seal(p.password);
      passwordStored = sealed !== null;
    }

    const machineId = newId();
    this.d.db.exec("BEGIN");
    let itemId: string;
    try {
      this.d.machines.insert({ id: machineId, spaceId: p.spaceId, name: p.name, source: p.source, endpoint: p.endpoint, sealedPassword: sealed });
      itemId = this.d.items.create({ spaceId: p.spaceId, kind: "machine", title: p.name, refId: machineId }).id;
      this.d.db.exec("COMMIT");
    } catch (e) {
      this.d.db.exec("ROLLBACK");
      throw e;
    }
    this.d.rpc.broadcast("items.changed", { spaceId: p.spaceId });
    return { machineId, itemId, passwordStored };
  }

  get(machineId: string): Machine {
    const row = this.d.machines.get(machineId);
    if (!row) throw new NotFoundError("machine", machineId);
    return row;
  }

  list(spaceId: string): Machine[] { return this.d.machines.list(spaceId); }

  stateOf(machineId: string): MachineState {
    return this.state.get(machineId) ?? { machineId, status: "off", wsUrl: null, width: null, height: null, error: null, detail: null };
  }

  /** Every live state, for a client that just connected and has no idea what is running. */
  states(spaceId: string): MachineState[] {
    return this.d.machines.list(spaceId).map((m) => this.stateOf(m.id));
  }

  update(machineId: string, patch: { name?: string; endpoint?: VncEndpoint; password?: string | null; headers?: Record<string, string> | null }): { passwordStored: boolean } {
    const row = this.d.machines.get(machineId);
    if (!row) throw new NotFoundError("machine", machineId);
    let sealed: string | null | undefined;
    let passwordStored = true;
    if (patch.password !== undefined) {
      if (patch.password === null || patch.password === "") sealed = null;
      else { sealed = machineSecretBox.seal(patch.password); passwordStored = sealed !== null; }
    }
    // Headers are a secret on the same terms — an ingress bearer is a credential — so they seal or
    // they are not stored, and `passwordStored` covers both because a form that saved one and
    // dropped the other would be telling half the truth.
    let sealedHeaders: string | null | undefined;
    if (patch.headers !== undefined) {
      if (patch.headers === null || Object.keys(patch.headers).length === 0) sealedHeaders = null;
      else { sealedHeaders = machineSecretBox.seal(JSON.stringify(patch.headers)); passwordStored &&= sealedHeaders !== null; }
    }
    this.d.machines.update(machineId, { name: patch.name, endpoint: patch.endpoint, sealedPassword: sealed, sealedHeaders });
    if (patch.name !== undefined) {
      const item = this.d.items.findByRefId(machineId);
      if (item && item.title !== patch.name) {
        this.d.items.update({ id: item.id, title: patch.name });
        this.d.rpc.broadcast("items.changed", { spaceId: item.spaceId });
      }
    }
    // An edit that moved the address or the password invalidates every live view of the OLD one.
    // Dropping them here rather than leaving them to notice is what stops a pane showing a machine
    // the row no longer describes.
    if (patch.endpoint !== undefined || patch.password !== undefined || patch.headers !== undefined) this.stop(machineId);
    return { passwordStored };
  }

  /**
   * Hand out a relay URL and go to `booting`.
   *
   * There is no process to spawn for a `vnc` machine, so "start" is exactly this: the URL exists,
   * the renderer opens it, and the proxy's own callbacks carry it the rest of the way. `booting`
   * rather than `running` is the honest state — nothing has reached the far end yet, and a remote
   * Mac that is asleep will accept a TCP connection and then say nothing at all.
   */
  start(machineId: string): MachineState {
    const row = this.d.machines.get(machineId);
    if (!row) throw new NotFoundError("machine", machineId);
    if (row.source !== "vnc") throw new RpcError("INVALID_ARGUMENT", UNBUILT[row.source as Exclude<MachineSource, "vnc">]);
    if (!row.endpoint) return this.fail(machineId, "unreachable", "this machine has no address saved");
    // Drop any previous bridge first: a Start on a machine that is already connected is a user
    // asking for a fresh connection, and two live sockets to one screen is two sets of input. The
    // agent's driver goes with it — its target may have moved.
    this.dropDriver(machineId);
    this.d.proxy.disconnect(machineId);
    const wsUrl = this.d.proxy.urlFor(machineId);
    this.d.machines.setWsPort(machineId, this.d.proxy.info().port);
    return this.set({ machineId, status: "booting", wsUrl, width: null, height: null, error: null, detail: null });
  }

  /**
   * The agent's own connection to this machine, or null when there is nowhere to connect to.
   *
   * Deliberately NOT gated on the human's connection being up: the whole point of a second socket is
   * that an agent can work on a machine nobody is watching. What it IS gated on is the row having an
   * address, because a machine with none has nothing to dial.
   */
  async driverFor(machineId: string): Promise<MachineDriver | null> {
    const existing = this.drivers.get(machineId);
    if (existing) return existing;
    const target = this.targetFor(machineId);
    if (!target) return null;
    const driver = new RfbDriver(target);
    this.drivers.set(machineId, driver);
    return driver;
  }

  /** Drop the agent's connection. Called wherever the human's is dropped, because a driver holding a
   *  socket to a machine the user stopped is exactly the invisible compute the sidebar dot exists
   *  to prevent — and this one has no dot. */
  private dropDriver(machineId: string): void {
    this.drivers.get(machineId)?.close();
    this.drivers.delete(machineId);
  }

  /** Drop the connection and go back to `off`. Idempotent: stopping a stopped machine is what a
   *  double-press of the power toggle is, and it is not an error. */
  stop(machineId: string): MachineState {
    this.dropDriver(machineId);
    this.d.proxy.disconnect(machineId);
    this.d.machines.setWsPort(machineId, null);
    return this.set({ machineId, status: "off", wsUrl: null, width: null, height: null, error: null, detail: null });
  }

  /* --------------------------- what the proxy tells us --------------------------- */

  onConnected(machineId: string, size: { width: number; height: number }): void {
    const prev = this.stateOf(machineId);
    this.set({ ...prev, status: "running", width: size.width, height: size.height, error: null, detail: null });
  }

  onFailed(machineId: string, error: string, detail: string): void {
    this.fail(machineId, error, detail);
  }

  /**
   * The far end hung up on a connection that was working.
   *
   * `off`, not `failed`: a screen-sharing session that ends because the other Mac went to sleep, or
   * because its user disconnected the viewer, is not a fault to be reported with a stderr well and a
   * Try again heading. It is a machine that is no longer connected, and Start is the whole recovery.
   * `MACHINE_ERRORS` still carries `disconnected` for the case the proxy sees mid-handshake, which
   * genuinely is a failure to connect.
   */
  onClosed(machineId: string): void {
    const prev = this.stateOf(machineId);
    if (prev.status === "failed") return; // a failure already said something better than "off"
    this.d.machines.setWsPort(machineId, null);
    this.set({ machineId, status: "off", wsUrl: null, width: null, height: null, error: null, detail: null });
  }

  /* --------------------------- lifecycle --------------------------- */

  /**
   * Startup. Starts NOTHING, and clears every recorded port.
   *
   * A port recorded against last run's listener is a lie, and the UNIQUE index would refuse to
   * reissue it — so a machine that was connected when Realm quit could never be given its own port
   * back. Connecting is also a real act against somebody else's Mac: it can wake it and it shows in
   * their screen-sharing indicator, so it is not something to do because the app was reopened.
   */
  restoreAll(): void {
    this.d.machines.clearAllWsPorts();
    this.state.clear();
    for (const id of [...this.drivers.keys()]) this.dropDriver(id);
  }

  /**
   * Closing a PANE does not disconnect a machine.
   *
   * The pane is a window onto something that outlives it — the same property the terminal hub has —
   * and it is what makes the pane bar's × a plain layout close rather than a trash. A machine whose
   * pane is closed keeps its connection and keeps wearing its dot in the sidebar.
   */
  closeFromLayout(_machineId: string): void { /* deliberately nothing; see the doc comment */ }

  /** The user deleting the machine itself: row, item, connection and state. */
  close(machineId: string): void {
    const row = this.d.machines.get(machineId);
    const item = this.d.items.findByRefId(machineId);
    if (!row && !item) throw new NotFoundError("machine", machineId);
    this.dropDriver(machineId);
    this.d.proxy.disconnect(machineId);
    this.state.delete(machineId);
    this.d.machines.delete(machineId);
    if (item) {
      this.d.items.delete(item.id);
      this.d.rpc.broadcast("items.changed", { spaceId: item.spaceId });
    }
  }

  /** A space is being deleted. The rows go with it by `ON DELETE CASCADE`; the live connections and
   *  the in-memory state do not, and a leaked socket to somebody's Mac is worse than a leaked row. */
  closeAllInSpace(spaceId: string): void {
    for (const m of this.d.machines.list(spaceId)) {
      this.dropDriver(m.id);
      this.d.proxy.disconnect(m.id);
      this.state.delete(m.id);
    }
  }

  /** Quit. Every bridge down before the process goes, so nothing is left half-open on a far end. */
  async closeAll(): Promise<void> {
    for (const id of [...this.drivers.keys()]) this.dropDriver(id);
    this.state.clear();
    await this.d.proxy.close();
  }

  /* --------------------------- the proxy's view of a machine --------------------------- */

  /**
   * Address + password, resolved at CONNECT time rather than held by the proxy.
   *
   * Late-bound deliberately: a machine whose address or password was edited between one pane and the
   * next must not reconnect to the old one, and a cached target is exactly how that happens.
   */
  targetFor(machineId: string): MachineTarget | null {
    const row = this.d.machines.get(machineId);
    if (!row || row.source !== "vnc" || !row.endpoint) return null;
    const stored = this.d.machines.sealedPassword(machineId);
    // A sealed password that will not open is NOT a reason to connect without one: the server would
    // refuse, and "auth_failed" with no explanation is worse than the truth. Handled as no password,
    // which produces exactly the "the server wants a password and none is saved" refusal.
    return {
      transport: row.endpoint.transport,
      host: row.endpoint.host,
      port: row.endpoint.port,
      path: row.endpoint.path,
      password: stored ? machineSecretBox.open(stored) : null,
      // The upgrade request's headers, for a sandbox behind an authenticating proxy. Sealed in the
      // same keyring the password is, and unsealed for the length of one dial.
      headers: this.headersFor(machineId),
    };
  }

  /** Stored headers, or undefined. A blob that will not open is undefined rather than an empty
   *  object: an authenticating proxy answers 401 either way, and the difference matters only in
   *  that one of them is a lie about having tried. */
  private headersFor(machineId: string): Record<string, string> | undefined {
    const stored = this.d.machines.sealedHeaders(machineId);
    if (!stored) return undefined;
    const json = machineSecretBox.open(stored);
    if (!json) return undefined;
    try {
      const v = JSON.parse(json) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
      return Object.keys(out).length ? out : undefined;
    } catch { return undefined; }
  }

  /* --------------------------- internals --------------------------- */

  private set(next: MachineState): MachineState {
    const prev = this.state.get(next.machineId);
    this.state.set(next.machineId, next);
    // The no-churn guard `applyBrowserDriving` makes: an identical state is not an event. A proxy
    // that reports the same size twice must not repaint every sidebar row that carries a dot.
    if (prev && prev.status === next.status && prev.wsUrl === next.wsUrl && prev.width === next.width
      && prev.height === next.height && prev.error === next.error && prev.detail === next.detail) return next;
    this.d.rpc.broadcast("machine.status", next);
    return next;
  }

  private fail(machineId: string, error: string, detail: string): MachineState {
    this.d.machines.setWsPort(machineId, null);
    // `detail` is the server's own words and is bounded at the schema, not here — this is the last
    // place that knows the difference between "a server said something long" and a truncation.
    return this.set({ machineId, status: "failed", wsUrl: null, width: null, height: null, error, detail });
  }
}
