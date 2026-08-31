import { newId, type Browser } from "@realm/contracts";
import type { Db } from "../db/database";
import type { RpcServer } from "../rpc/server";
import type { BrowsersStore } from "../store/browsers";
import type { ItemsStore } from "../store/items";
import type { SpacesStore } from "../store/spaces";
import { NotFoundError } from "../store/rows";

/**
 * Owns the browser pair: DB row + sidebar item (Plan 11 W1). Nothing else should touch the
 * `browsers` table. Unlike the terminal trio there is no third, process-shaped member here — the
 * native WebContentsView lives in Electron main, is driven renderer↔main over IPC, and is expected
 * to die whenever its pane closes. A restart restores only what this service persisted.
 */
export class BrowserService {
  constructor(private d: { db: Db; rpc: RpcServer; spaces: SpacesStore; items: ItemsStore; browsers: BrowsersStore }) {}

  open(p: { spaceId: string; url: string }): { browserId: string; itemId: string; url: string } {
    const space = this.d.spaces.get(p.spaceId); if (!space) throw new NotFoundError("space", p.spaceId);
    const browserId = newId();
    this.d.db.exec("BEGIN");
    let itemId: string;
    try {
      this.d.browsers.insert({ id: browserId, spaceId: p.spaceId, url: p.url, title: "Browser" });
      itemId = this.d.items.create({ spaceId: p.spaceId, kind: "browser", title: "Browser", refId: browserId }).id;
      this.d.db.exec("COMMIT");
    } catch (e) {
      this.d.db.exec("ROLLBACK");
      throw e;
    }
    this.d.rpc.broadcast("items.changed", { spaceId: p.spaceId });
    return { browserId, itemId, url: p.url };
  }

  get(browserId: string): Browser {
    const row = this.d.browsers.get(browserId);
    if (!row) throw new NotFoundError("browser", browserId);
    return row;
  }

  /** Persist last committed url/title. A title change renames the item too — the sidebar and pane
   *  header track the page, like a browser tab. (A later manual rename is therefore overwritten by
   *  the next navigation; a pinned name is not a W1 concern.) */
  update(browserId: string, patch: { url?: string; title?: string }): void {
    const row = this.d.browsers.update(browserId, patch);
    if (!row) throw new NotFoundError("browser", browserId);
    if (patch.title !== undefined) {
      const item = this.d.items.findByRefId(browserId);
      if (item && item.title !== patch.title) {
        this.d.items.update({ id: item.id, title: patch.title || "Browser" });
        this.d.rpc.broadcast("items.changed", { spaceId: item.spaceId });
      }
    }
  }

  /** Delete row + item. Throws NOT_FOUND when neither exists (double-close is a caller bug). */
  close(browserId: string): void {
    const row = this.d.browsers.get(browserId);
    const item = this.d.items.findByRefId(browserId);
    if (!row && !item) throw new NotFoundError("browser", browserId);
    this.d.browsers.delete(browserId);
    if (item) {
      this.d.items.delete(item.id);
      this.d.rpc.broadcast("items.changed", { spaceId: item.spaceId });
    }
  }
}
