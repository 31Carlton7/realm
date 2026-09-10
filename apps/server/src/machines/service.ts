import { newId, type GuestSpec, type Machine, type MachineSource, type MachineState, type VncEndpoint } from "@realm/contracts";
import { join } from "node:path";
import type { Db } from "../db/database";
import type { RpcServer } from "../rpc/server";
import type { ItemsStore } from "../store/items";
import type { MachinesStore } from "../store/machines";
import type { SpacesStore } from "../store/spaces";
import { NotFoundError, RpcError } from "../store/rows";
import { machineSecretBox } from "./secret";
import { RfbDriver } from "./rfb-driver";
import { QmpDriver } from "./qmp-driver";
import { QemuManager } from "./qemu-manager";
import { accelFor, locateQemu, type QemuCapabilities } from "./qemu-locator";
import { diskPath, portForDisplay, type QemuArch } from "./qemu-argv";
import type { ImageStore } from "./images";
import { CATALOG } from "./catalog-data";
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
  /** `<realmHome>/machines` — where guests keep their disks, and images their bytes. */
  machinesDir: string;
  images: ImageStore;
  qemu: QemuManager;
  /** Test seam over `locateQemu`, so a suite never depends on whether this Mac has QEMU. */
  locate?: () => Promise<QemuCapabilities>;
};

/** The sources this release cannot reach, and the sentence each gets. `qemu` and `vnc` are built. */
const UNBUILT: Record<"mac" | "container", string> = {
  mac: "Realm cannot show this Mac's own screen yet — connect another machine by address instead.",
  container: "Realm cannot start a container yet — a container that serves a screen can be connected by address like any other.",
};

/**
 * Display numbers are allocated from a base well clear of anything a person runs by hand.
 *
 * 5900 is display 0 and is what a Mac's own Screen Sharing uses; the first few after it are what an
 * `x11vnc` or a hand-started `Xvfb` land on. Starting at 40 means a Realm guest never collides with
 * something the user started themselves — which would show up as a guest that boots and then serves
 * somebody else's screen, or refuses to bind with a message about a port.
 */
const DISPLAY_BASE = 40;
const DISPLAY_MAX = 240;

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

  /** Guest shapes by machine id, for `qemu` machines. Held in memory and mirrored into `settings` by
   *  the caller, so a restart restores them — see `hydrateGuests`. */
  private readonly guests = new Map<string, GuestSpec>();
  private caps: QemuCapabilities | null = null;
  /** In-flight image downloads, so Cancel has something to pull. */
  private readonly downloads = new Map<string, AbortController>();

  constructor(private readonly d: MachineServiceDeps) {}

  /**
   * Row + item + one broadcast, inside one transaction. The split `terminals.create` makes: nothing
   * that can fail slowly — a socket, a port, a handshake — happens in here, so a half-created
   * machine is not a state the database can hold.
   */
  create(p: { spaceId: string; name: string; source: MachineSource; endpoint: VncEndpoint | null; password?: string | null; guest?: GuestSpec | null }): { machineId: string; itemId: string; passwordStored: boolean } {
    const space = this.d.spaces.get(p.spaceId);
    if (!space) throw new NotFoundError("space", p.spaceId);
    if (p.source === "mac" || p.source === "container") throw new RpcError("INVALID_ARGUMENT", UNBUILT[p.source]);
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
      // A guest's shape — architecture, memory, disk, which image it boots — is Realm's own
      // configuration rather than a secret or an address, so it rides the endpoint column's sibling
      // in `settings` keyed by machine id. No migration: it is a JSON blob nobody queries across.
      if (p.guest) this.guests.set(machineId, p.guest);
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
    if (row.source === "mac" || row.source === "container") throw new RpcError("INVALID_ARGUMENT", UNBUILT[row.source]);
    if (row.source === "qemu") {
      // Answered synchronously with `booting`; the boot itself continues behind the `machine.status`
      // events. An RPC that waited for a guest to come up would hold a socket for a minute.
      void this.startQemu(machineId, row).catch((e) => this.fail(machineId, "unreachable", e instanceof Error ? e.message : String(e)));
      return this.set({ machineId, status: "booting", wsUrl: null, width: null, height: null, error: null, detail: null });
    }
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
    const row = this.d.machines.get(machineId);
    if (!row) return null;
    /* QMP for a guest Realm booted, RFB for everything else — and QMP is the better channel where it
       exists: a unix socket with filesystem permissions, and it works with NO VIEWER CONNECTED at
       all. The pane's socket may be closed and `screendump` still produces a frame. */
    if (row.source === "qemu") {
      const handle = this.d.qemu.handle(machineId);
      if (!handle) return null;
      const driver = new QmpDriver(handle.qmp, join(this.d.machinesDir, machineId));
      this.drivers.set(machineId, driver);
      return driver;
    }
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
    // The guest itself, where there is one. `graceful` so a Linux guest flushes its filesystem —
    // the difference between a clean shutdown and a disk image that fscks on next boot.
    if (this.d.qemu.has(machineId)) void this.d.qemu.stop(machineId, true).catch(() => {});
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
  /** Guest shapes back from the caller's own store, at boot. Separate from `restoreAll` because the
   *  shapes come from `settings` and this class does not own that table. */
  hydrateGuests(entries: Iterable<[string, GuestSpec]>): void {
    for (const [id, spec] of entries) this.guests.set(id, spec);
  }

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
    // A download for a machine that no longer exists has nowhere to land, and would keep writing.
    this.cancelImage(machineId);
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
    /* Awaited, and before the database closes. Un-awaited it orphans QEMU, which then holds the
       qcow2's own lock — and the next start fails with a message about a locked image that reads
       like corruption. */
    await this.d.qemu.stopAll();
    await this.d.proxy.close();
  }

  /* --------------------------- the proxy's view of a machine --------------------------- */

  /**
   * Address + password, resolved at CONNECT time rather than held by the proxy.
   *
   * Late-bound deliberately: a machine whose address or password was edited between one pane and the
   * next must not reconnect to the old one, and a cached target is exactly how that happens.
   */
  /**
   * What QEMU this Mac has, and what Realm can therefore offer.
   *
   * Asked once and cached, because it shells out twice and the answer does not change while Realm is
   * running. `null` for `qemu` is the honest shape: the connect flow leaves that route out entirely
   * rather than offering a disabled one — design.md, "where the owner has said nothing, show
   * nothing, not a disabled control".
   */
  async capabilities(): Promise<{ qemu: QemuCapabilities; catalog: typeof CATALOG }> {
    this.caps ??= await (this.d.locate ?? locateQemu)();
    return { qemu: this.caps, catalog: CATALOG };
  }

  /** The guest's shape, for a `qemu` machine. */
  guestOf(machineId: string): GuestSpec | null { return this.guests.get(machineId) ?? null; }

  /** Remember one, and hand it to the caller to persist — this class does not own `settings`. */
  setGuest(machineId: string, spec: GuestSpec): void { this.guests.set(machineId, spec); }

  images(): ImageStore { return this.d.images; }

  /**
   * Fetch the image a guest needs, in the background, reporting as it goes.
   *
   * The download does NOT block anything: the row and the pane exist already, and the pane's body
   * becomes the download's own state. The user can close it, switch spaces and come back — because
   * the download is the SERVER's and the pane is a view of it. That is the same "a pane is a window
   * onto a process that outlives it" property the terminal hub has, and it is what makes the pane
   * bar's × a layout close rather than a cancel.
   */
  async fetchImage(machineId: string, entry: { id: string; url: string; sha256: string; bytes: number; kind: "disk" | "iso"; name: string }): Promise<void> {
    const kind: "qcow2" | "iso" = entry.kind === "iso" ? "iso" : "qcow2";
    const spaceId = this.d.machines.get(machineId)?.spaceId;
    if (!spaceId) return;
    const emit = (received: number, total: number | null, done: boolean, error: string | null, detail: string | null) =>
      this.d.rpc.broadcast("machineImage.progress", { machineId, sha256: entry.sha256, received, total, done, error, detail });
    const controller = new AbortController();
    this.downloads.set(machineId, controller);
    try {
      emit(0, entry.bytes, false, null, null);
      await this.d.images.download({
        sha256: entry.sha256, kind, url: entry.url, name: entry.name, expectedBytes: entry.bytes,
        signal: controller.signal,
        onProgress: (p) => emit(p.received, p.total, false, null, null),
      });
      const guest = this.guestOf(machineId);
      if (guest) this.setGuest(machineId, { ...guest, imageSha: entry.sha256, imageKind: kind, catalogId: entry.id });
      emit(entry.bytes, entry.bytes, true, null, null);
      // Straight on to booting, which is what "the download advances to `booting` on its own" means.
      this.start(machineId);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "offline";
      emit(0, entry.bytes, true, code, e instanceof Error ? e.message : String(e));
      this.fail(machineId, code, e instanceof Error ? e.message : String(e));
    } finally {
      this.downloads.delete(machineId);
    }
  }

  /** Stop a download the user changed their mind about. Idempotent. */
  cancelImage(machineId: string): void {
    this.downloads.get(machineId)?.abort();
    this.downloads.delete(machineId);
  }

  /**
   * Boot a guest.
   *
   * Split from `start` deliberately: everything that can fail SLOWLY — locating QEMU, allocating a
   * display, waiting for four conditions — happens here, outside the transaction `create` runs in
   * and outside the synchronous path the RPC answers on.
   */
  private async startQemu(machineId: string, row: Machine): Promise<MachineState> {
    const guest = this.guestOf(machineId);
    if (!guest) return this.fail(machineId, "source_unavailable", "this machine has no guest configuration saved");
    const { qemu } = await this.capabilities();
    if (qemu.unavailable) return this.fail(machineId, "source_unavailable", qemu.unavailable);
    const binary = qemu.binaries[guest.arch];
    if (!binary || !qemu.shareDir) {
      return this.fail(machineId, "source_unavailable", `QEMU here cannot run ${guest.arch} guests.`);
    }
    const imagePath = guest.imageSha ? this.d.images.pathFor(guest.imageSha, guest.imageKind ?? "iso") : null;
    const dir = join(this.d.machinesDir, machineId);
    const display = await this.allocateDisplay();
    if (display === null) return this.fail(machineId, "unreachable", "every screen port Realm allocates from is in use.");
    this.set({ machineId, status: "booting", wsUrl: null, width: null, height: null, error: null, detail: null });
    try {
      await this.d.qemu.start(machineId, {
        arch: guest.arch, dir, shareDir: qemu.shareDir, display,
        memoryMb: guest.memoryMb, cpus: guest.cpus, title: row.name,
        isoPath: guest.imageKind === "iso" ? imagePath : null,
        accel: accelFor(qemu, guest.arch),
      }, (reason, disposed) => {
        /* A crash KEEPS the row, which is the one place this departs from `TerminalService.onExit`.
           A dead pty has no state worth keeping; a dead VM still owns a disk image and a
           configuration the user chose, and "start it again" is the whole recovery. */
        if (disposed) this.onClosed(machineId);
        else this.fail(machineId, "disconnected", reason);
      });
    } catch (e) {
      return this.fail(machineId, "unreachable", e instanceof Error ? e.message : String(e));
    }
    // The endpoint is loopback, on the port the guest is now serving. Written to the row so a
    // restart's cleanup and the proxy both find it the same way a `vnc` machine's is found.
    this.d.machines.update(machineId, { endpoint: { transport: "tcp", host: "127.0.0.1", port: portForDisplay(display), path: "/websockify" } });
    this.d.proxy.disconnect(machineId);
    const wsUrl = this.d.proxy.urlFor(machineId);
    this.d.machines.setWsPort(machineId, this.d.proxy.info().port);
    return this.set({ machineId, status: "booting", wsUrl, width: null, height: null, error: null, detail: null });
  }

  /** A free display number, probed rather than counted — another Realm, or the user's own x11vnc,
   *  may hold one and a number this process has not handed out is not the same as a free port. */
  private async allocateDisplay(): Promise<number | null> {
    const { probeConnect } = await import("../workspace/ports");
    const taken = new Set(this.d.machines.all().map((m) => m.endpoint?.port).filter((p): p is number => typeof p === "number"));
    for (let d = DISPLAY_BASE; d < DISPLAY_MAX; d++) {
      const port = portForDisplay(d);
      if (taken.has(port)) continue;
      if (!(await probeConnect(port, "127.0.0.1", 150))) return d;
    }
    return null;
  }

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
