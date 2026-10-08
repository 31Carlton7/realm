import { spawn } from "node:child_process";

/** What holds the Mac awake: one long-lived child, let go by killing it. */
export type AwakeHolder = { kill(): void; once(event: "exit" | "error", listener: () => void): unknown };
export type HoldAwake = () => AwakeHolder;

/** `caffeinate -i` prevents idle sleep only, as main's `prevent-app-suspension` does, so the display can
 *  still sleep. `-w` ties it to this server, so a server that crashes cannot leave the Mac awake. */
const caffeinate: HoldAwake = () => spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });

/**
 * Keeps the Mac awake for Realm Mobile when no Realm app is attached to do it (Plan 28 Phase 2).
 *
 * While the app runs, Electron main holds the Mac awake (`apps/desktop/src/main/sleep-guard.ts`). A
 * daemon left running after the app quits has nobody doing that, and a paired phone is why that
 * matters: the owner can answer a waiting session from the phone, but not if the Mac has gone to
 * sleep. So with no app attached, the server applies main's rule itself. It holds while the owner's
 * "keep the Mac awake" preference is on and a session is working, or, with a phone paired, a session
 * is waiting on its owner.
 */
export class HeadlessKeepAwake {
  private holder: AwakeHolder | null = null;

  constructor(private readonly o: {
    /** Whether the Realm app is attached. While it is, it holds the Mac awake itself. */
    attached: () => boolean;
    /** Settings ▸ General ▸ Power's "keep the Mac awake". */
    wanted: () => boolean;
    counts: () => { working: number; needsYou: number };
    /** Phones paired with this Mac. */
    phones: () => number;
    /** Only macOS has caffeinate: by default nothing is held anywhere else. */
    hold?: HoldAwake | null;
  }) {}

  get holding(): boolean { return this.holder !== null; }

  /** Re-reads every input, then holds or lets go. Held at most once. */
  refresh(): void {
    const hold = !this.o.attached() && this.o.wanted() && this.needed();
    if (hold && !this.holder) this.start();
    else if (!hold && this.holder) this.release();
  }

  close(): void { this.release(); }

  private needed(): boolean {
    const { working, needsYou } = this.o.counts();
    return working > 0 || (needsYou > 0 && this.o.phones() > 0);
  }

  private start(): void {
    const make = this.o.hold === undefined ? (process.platform === "darwin" ? caffeinate : null) : this.o.hold;
    if (!make) return;
    const holder = make();
    this.holder = holder;
    // Gone on its own, or never started: the next refresh holds again.
    const gone = () => { if (this.holder === holder) this.holder = null; };
    holder.once("exit", gone);
    holder.once("error", gone);
  }

  private release(): void {
    const holder = this.holder;
    this.holder = null;
    try { holder?.kill(); } catch { /* already gone */ }
  }
}
