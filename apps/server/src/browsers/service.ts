import { isFaviconDataUrl, newId, type Browser, type BrowserHistoryPage } from "@realm/contracts";
import type { Db } from "../db/database";
import type { RpcServer } from "../rpc/server";
import { isHistoryUrl, type BrowserHistoryStore } from "../store/browser-history";
import type { BrowsersStore } from "../store/browsers";
import type { ItemsStore } from "../store/items";
import type { SpacesStore } from "../store/spaces";
import type { ProfilesStore } from "../store/profiles";
import { NotFoundError } from "../store/rows";

/**
 * Owns the browser pair: DB row + sidebar item (Plan 11 W1). Nothing else should touch the
 * `browsers` table. Unlike the terminal trio there is no third, process-shaped member here — the
 * native WebContentsView lives in Electron main, is driven renderer↔main over IPC, and is expected
 * to die whenever its pane closes. A restart restores only what this service persisted.
 */
export class BrowserService {
  constructor(private d: { db: Db; rpc: RpcServer; spaces: SpacesStore; items: ItemsStore; browsers: BrowsersStore; history: BrowserHistoryStore; now?: () => number }) {}

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

  /** Persist last committed url/title/favicon. A title change renames the item too — the sidebar and
   *  pane header track the page, like a browser tab. (A later manual rename is therefore overwritten by
   *  the next navigation; a pinned name is not a W1 concern.) A favicon change is the item's too: every
   *  read of the item carries the row's icon, so the lists are told to read again.
   *
   *  The icon is the page's, so it never outlives the page: a new url with no favicon beside it clears
   *  the old one rather than lending it to a page that never showed it. And one that is not a favicon
   *  as Realm keeps them (`isFaviconDataUrl`) is kept as none. */
  update(browserId: string, patch: { url?: string; title?: string; favicon?: string }): void {
    const before = this.d.browsers.get(browserId);
    const favicon = patch.favicon !== undefined ? (isFaviconDataUrl(patch.favicon) ? patch.favicon : "")
      : patch.url !== undefined && patch.url !== before?.url ? "" : undefined;
    const row = this.d.browsers.update(browserId, { url: patch.url, title: patch.title, favicon });
    if (!row) throw new NotFoundError("browser", browserId);
    this.recordHistory(before, row);
    const item = this.d.items.findByRefId(browserId);
    if (!item) return;
    let changed = false;
    if (patch.title !== undefined && item.title !== patch.title) {
      this.d.items.update({ id: item.id, title: patch.title || "Browser" });
      changed = true;
    }
    if (row.favicon !== (before?.favicon ?? "")) changed = true;
    if (changed) this.d.rpc.broadcast("items.changed", { spaceId: item.spaceId });
  }

  /**
   * The address field's suggestions, from the history of the profile this space belongs to. A space
   * that is not there has no profile and so no history — an empty list rather than a guess.
   */
  suggest(spaceId: string, query: string, limit: number): BrowserHistoryPage[] {
    const space = this.d.spaces.get(spaceId);
    return space ? this.d.history.search(space.profileId, query, limit) : [];
  }

  /** A blank tab's Recently visited, read from the same profile's history the suggestions come from. */
  recent(spaceId: string, limit: number): BrowserHistoryPage[] {
    const space = this.d.spaces.get(spaceId);
    return space ? this.d.history.recent(space.profileId, limit) : [];
  }

  /** The profile a pane belongs to — its space's — and that profile's partition. NOT_FOUND for a pane,
   *  space or profile that is gone: main then gives the pane no view at all rather than a guess. */
  profileOf(browserId: string, profiles: Pick<ProfilesStore, "get">): { profileId: string; partition: string } {
    const row = this.get(browserId);
    const space = this.d.spaces.get(row.spaceId); if (!space) throw new NotFoundError("space", row.spaceId);
    const profile = profiles.get(space.profileId); if (!profile) throw new NotFoundError("profile", space.profileId);
    return { profileId: profile.id, partition: profile.browserPartition };
  }

  /** One profile's history goes, as its partition's cookies and cache did a moment before. Another
   *  profile's panes have their own partition, and their own history. */
  clearHistory(profileId: string): void {
    this.d.history.clearProfile(profileId);
  }

  /**
   * A visit is a pane's committed url CHANGING — which is what `update` hears, because the pane
   * persists after every navigation settles (debounced, so a redirect chain lands once, on where it
   * ended). The same url with a new title is the page renaming itself after load, or a single-page app
   * retitling a view: the row is renamed and no visit is counted, or every SPA would rank first.
   */
  private recordHistory(before: Browser | null, after: Browser): void {
    if (!isHistoryUrl(after.url)) return;
    const profileId = this.d.spaces.get(after.spaceId)?.profileId;
    if (!profileId) return;
    if (before?.url === after.url) this.d.history.retitle(profileId, after.url, after.title);
    else this.d.history.recordVisit(profileId, after.url, after.title, this.d.now?.() ?? Date.now());
    // The row's icon is this page's by now — `update` cleared the last page's off it.
    this.d.history.setFavicon(profileId, after.url, after.favicon);
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
