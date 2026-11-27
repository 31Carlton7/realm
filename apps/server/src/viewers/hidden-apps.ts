import { newId } from "@realm/contracts";

/** One quiet app Realm launched, with the DevTools port Realm gave it. */
export type HiddenApp = { id: string; cdpPort: number; pid: number | null };

/**
 * The quiet apps Realm's own launcher started, each with the `--remote-debugging-port` it was handed.
 * A viewer opens only on one of these: the port is never taken from whoever asks, so a viewer cannot
 * be pointed at the owner's Realm, Chrome, or any other app that happens to have a debug port open.
 *
 * Only the launcher writes here, in process. Nothing over RPC can add an entry.
 */
export class HiddenApps {
  private readonly apps = new Map<string, HiddenApp>();

  record(app: Omit<HiddenApp, "id">): HiddenApp {
    const entry = { id: newId(), ...app };
    this.apps.set(entry.id, entry);
    return entry;
  }

  get(id: string): HiddenApp | undefined {
    return this.apps.get(id);
  }

  forget(id: string): void {
    this.apps.delete(id);
  }
}
