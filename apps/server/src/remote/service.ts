import { randomBytes } from "node:crypto";
import { REMOTE_RELAY_KEY, STAGING_REMOTE_RELAY, type PairingWindow, type RemoteState, type RemoteStatus } from "@realm/contracts";
import { relayBase } from "@realm/remote";
import type { RpcServer } from "../rpc/server";
import type { RemoteDevicesStore } from "../store/remote-devices";
import { NotFoundError, RpcError } from "../store/rows";
import type { SettingsStore } from "../store/settings";
import { RemoteGateway, type PushPayload, type PushResult } from "./gateway";
import { MacKeys, REMOTE_IDENTITY_KEY } from "./keys";
import { inProcessRpc } from "./rpc-port";
import { remoteSecretBox } from "./secret";
import type { MacIdentity, PairedPhone } from "./store";

export type RemoteServiceOptions = {
  rpc: RpcServer;
  settings: SettingsStore;
  phones: RemoteDevicesStore;
  /** The name a phone shows for this Mac: its ComputerName, as `system.info` reports it. */
  macName: string;
  version: string;
  /** Where development builds' `debug.report` writes. */
  reportsDir: string;
  /** The Realm home: a file a phone sends is written under its `tmp/attachments`, as a desktop paste is. */
  home: string;
  /** The relay to dial when the `remote.relay` setting names none. Only `main.ts` passes one, so an app
   *  a test builds dials nothing unless the test names a relay itself. */
  defaultRelay?: string | null;
  /** Development builds: `debug.report` answers. */
  dev?: boolean;
  /** Tests: the pairing link's scheme. */
  linkBase?: string;
  /** Tests: how long a pairing window stays open (5 minutes). */
  pairTtlMs?: number;
  /** Tests: how long `pair.start` waits for the relay before saying it cannot reach it. */
  relayWaitMs?: number;
  log?: (line: string) => void;
};

/** How long `pair.start` waits for the relay to answer before saying it cannot be reached. */
const RELAY_WAIT_MS = 10_000;

/**
 * Realm Mobile on the Mac (Plan 28): the gateway's owner, and what Settings ▸ Devices talks to.
 *
 * It dials the relay only while there is a reason to — a phone paired, or a pairing window open — and
 * reports `off` otherwise, so a Mac that never paired a phone opens no socket to anyone. Its identity is
 * sealed under the `remote` secret domain, so until Electron main hands that key over it is `locked`:
 * a daemon that restarted with no Realm window has no keys, and its phones see the Mac as offline.
 *
 * Every change of state reaches Settings as `remote.changed`, with the whole status; a phone that
 * proved it holds the QR code's secret reaches it as `remote.pairRequest`, and only the owner's yes —
 * `remote.pair.answer` — adds it.
 */
export class RemoteService {
  private readonly keys: MacKeys;
  private identity: MacIdentity | null = null;
  private gateway: RemoteGateway | null = null;
  /** Phones waiting on the owner's answer, by request id. */
  private readonly requests = new Map<string, { windowId: string; answer: (yes: boolean) => void }>();
  private lastStatus = "";
  private closed = false;
  /** `pair.start`s waiting on the relay: each one a reason to keep dialling (`reconcile`). */
  private opening = 0;
  /** How to stop each of those waits, should the link it waits on be hung up first. */
  private readonly waits = new Set<() => void>();

  constructor(private readonly o: RemoteServiceOptions) {
    this.keys = new MacKeys(o.settings);
  }

  /** After `rpc.listen`: opens the identity if the key is already here, and dials if a phone is paired. */
  start(): void {
    // A phone paired before the Mac wrote down each phone's relay was paired on the one it dialled then:
    // the relay setting, or the only relay Realm had. Written in, so the gateway can go and find it.
    const then = relayBase(this.o.settings.get(REMOTE_RELAY_KEY)) ?? STAGING_REMOTE_RELAY;
    const adopted = this.o.phones.adoptRelay(then);
    if (adopted > 0) this.o.log?.(`[remote] ${adopted} phone(s) paired before relays were recorded are on ${then}`);
    this.unlock();
  }

  /** The `remote.relay` setting changed: the Mac moves, and its phones follow it (PROTOCOL.md §3.3). */
  relayChanged(): void { this.reconcile(); }

  /** Electron main handed the `remote` key over: the identity can open now, and the link start. */
  keyChanged(): void { this.unlock(); }

  status(): RemoteStatus {
    return {
      state: this.state(),
      relay: this.relay() ?? "",
      macName: this.o.macName,
      phones: this.o.phones.list().map(({ phoneId, name, model, addedAt, lastSeen }) => ({ phoneId, name, model, addedAt, lastSeen })),
      pairing: this.gateway?.pairing ?? null,
    };
  }

  /**
   * Opens a pairing window (replacing any open one) and returns the link its QR code carries. It waits
   * for the relay first: a window is only opened at a relay that has answered, so a code on screen is
   * one a phone can actually use, and a relay that cannot be reached is said rather than drawn.
   */
  async pairStart(): Promise<PairingWindow> {
    if (this.closed) throw new RpcError("UNAVAILABLE", "Realm is shutting down");
    // A key that has arrived since the last look may open the identity already stored. Minting over it
    // would cut off every phone that pinned it.
    if (!this.identity) this.unlock();
    if (!this.identity) {
      const minted = this.keys.mint();
      if (!minted) throw new RpcError("REMOTE_LOCKED", "Realm can't reach this Mac's keychain, so it can't pair a phone yet. Open Realm on this Mac, then try again.");
      // A new identity orphans every phone paired to an old one: they pinned keys this Mac no longer has.
      this.o.phones.clear();
      this.identity = minted;
    }
    const relay = this.relay();
    if (!relay) throw new RpcError("UNAVAILABLE", "No relay is set for Realm Mobile");
    this.opening += 1;
    try {
      const gateway = this.running(relay);
      await this.reachable(gateway);
      if (this.gateway !== gateway) throw new RpcError("UNAVAILABLE", "Realm Mobile restarted while the window was opening. Try again.");
      return gateway.openPairing(this.o.pairTtlMs);
    } finally {
      // A relay that never answered leaves nothing to dial for, unless a phone is paired.
      this.opening -= 1;
      this.reconcile();
    }
  }

  pairCancel(): void {
    this.gateway?.closePairing();
    this.settleRequests();
    this.reconcile();
  }

  /** The owner's answer to `remote.pairRequest`. Only a yes adds the phone. */
  pairAnswer(requestId: string, accept: boolean): void {
    const request = this.requests.get(requestId);
    if (!request) throw new NotFoundError("pairing request", requestId);
    request.answer(accept);
  }

  /** Remove: the relay forgets the phone's key and its channel closes at once. */
  removePhone(phoneId: string): void {
    if (!this.o.phones.get(phoneId)) throw new NotFoundError("phone", phoneId);
    // With the link down the row still goes, and the relay is sent the shorter list on the next `ready`.
    if (this.gateway) this.gateway.revoke(phoneId);
    else this.o.phones.remove(phoneId);
    this.reconcile();
  }

  phones(): PairedPhone[] { return this.o.phones.list(); }

  /** Seals one push to one phone and hands it to the relay (`remote/push.ts` decides when). */
  push(phoneId: string, payload: PushPayload, o: { urgent: boolean; collapse: string | null; badge: number | null }): Promise<PushResult> {
    if (!this.gateway) return Promise.resolve({ ok: false, status: 0, reason: "relay-offline" });
    return this.gateway.push(phoneId, payload, o);
  }

  close(): void {
    this.closed = true;
    this.hangUp();
    for (const r of [...this.requests.values()]) r.answer(false);
  }

  private state(): RemoteState {
    if (!this.identity) return remoteSecretBox.available ? "off" : "locked";
    return this.gateway ? this.gateway.state : "off";
  }

  private relay(): string | null {
    return relayBase(this.o.settings.get(REMOTE_RELAY_KEY)) ?? this.o.defaultRelay ?? null;
  }

  private unlock(): void {
    if (this.closed) return;
    if (!this.identity) {
      const loaded = this.keys.load();
      if (loaded.kind === "ok") {
        this.identity = loaded.identity;
      } else if (loaded.kind === "unopenable") {
        // The keyring it was sealed under is gone, and with it the keys every phone pinned. Those phones
        // can never connect again, so they are forgotten with it; pairing again starts afresh.
        this.o.log?.("[remote] this Mac's identity no longer opens with its key; forgetting its paired phones");
        this.o.phones.clear();
        this.o.settings.set(REMOTE_IDENTITY_KEY, null);
      }
    }
    this.reconcile();
  }

  /** Dial while there is a reason to, hang up when there is none, and tell Settings either way. */
  private reconcile(): void {
    if (this.closed) return;
    const relay = this.relay();
    const wanted = this.identity !== null && relay !== null
      && (this.opening > 0 || this.gateway?.pairing != null || this.gateway?.pairingBusy === true || this.o.phones.list().length > 0);
    if (wanted) this.running(relay!);
    else if (this.gateway) this.hangUp();
    this.changed();
  }

  /** The gateway, dialling `relay` — built and started if it is not, rebuilt if the relay moved. */
  private running(relay: string): RemoteGateway {
    if (this.gateway?.relay === relay) return this.gateway;
    if (this.gateway) this.hangUp();
    const gateway: RemoteGateway = new RemoteGateway({
      identity: this.identity!, phones: this.o.phones, relay,
      rpc: inProcessRpc(this.o.rpc, "local"),
      rpcFor: (phoneId) => inProcessRpc(this.o.rpc, `phone:${phoneId}`),
      macName: this.o.macName, version: this.o.version, reportsDir: this.o.reportsDir, realmHome: this.o.home,
      dev: this.o.dev, linkBase: this.o.linkBase, log: this.o.log,
      confirm: (phone) => this.ask(phone),
      // A gateway already hung up may still report on its way down; only the current one counts.
      onChange: () => { if (this.gateway !== gateway) return; this.settleRequests(); this.reconcile(); },
    });
    gateway.onState(() => { if (this.gateway === gateway) this.changed(); });
    this.gateway = gateway;
    gateway.start();
    return gateway;
  }

  private reachable(gateway: RemoteGateway): Promise<void> {
    if (gateway.state === "connected") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (err?: RpcError): void => {
        clearTimeout(timer);
        off();
        this.waits.delete(hungUp);
        if (err) reject(err); else resolve();
      };
      // The app closing, or the relay setting moving, leaves nothing to wait on.
      const hungUp = (): void => done(new RpcError("UNAVAILABLE", "Realm Mobile stopped while the window was opening. Try again."));
      const timer = setTimeout(() => done(new RpcError("RELAY_UNREACHABLE",
        "Realm can't reach its relay, so no phone can pair right now. Check this Mac's connection, then try again.")), this.o.relayWaitMs ?? RELAY_WAIT_MS);
      timer.unref?.();
      const off = gateway.onState((s) => { if (s === "connected") done(); });
      this.waits.add(hungUp);
    });
  }

  private hangUp(): void {
    const gateway = this.gateway;
    this.gateway = null;
    gateway?.stop();
    this.settleRequests();
    for (const stop of [...this.waits]) stop();
  }

  /** Puts a phone in front of the owner. The gateway races the answer against the window's expiry. */
  private ask(phone: { name: string; model: string; windowId: string }): Promise<boolean> {
    return new Promise((resolve) => {
      const requestId = randomBytes(12).toString("base64url");
      this.requests.set(requestId, { windowId: phone.windowId, answer: (yes) => { this.requests.delete(requestId); resolve(yes); } });
      this.o.rpc.broadcast("remote.pairRequest", { requestId, windowId: phone.windowId, name: phone.name, model: phone.model });
    });
  }

  /** A request belongs to its window: once that window is closed, replaced or expired, it is a no. */
  private settleRequests(): void {
    const open = this.gateway?.pairing?.windowId ?? null;
    for (const r of [...this.requests.values()]) if (r.windowId !== open) r.answer(false);
  }

  /** `remote.changed`, with the whole status — sent only when the status did change. */
  private changed(): void {
    const status = this.status();
    const json = JSON.stringify(status);
    if (json === this.lastStatus) return;
    this.lastStatus = json;
    this.o.rpc.broadcast("remote.changed", status);
  }
}
