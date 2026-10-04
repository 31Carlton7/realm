/**
 * Every browser's page — address, title, icon — saved as it changes, whether or not a pane is showing
 * that browser. The sidebar row and the tab read their title and mark from what is saved.
 *
 * This used to live in the browser pane, which saved only while it was mounted. An agent driving a
 * browser no pane was showing — kept in a side pane that was not on screen, or opened with none —
 * left its row naming the page it started on (reported 09-23: "browser row title stale after
 * `browser_navigate`"). The pane still shows the page; this is what keeps the record of it.
 *
 * The rules are the pane's, unchanged. A state still loading, or with no address or no title yet, is
 * not saved: main names a view's bootstrap nothing, and saving it would rename a restored tab
 * "Browser" while its page is on the way. A page that has not offered its icon YET keeps the one it
 * had at the same address, so a relaunched tab reloading its page does not trade its icon for the
 * glyph while the icon is fetched again; a new address with none is a page with none. Writes are
 * debounced per browser, and one equal to what is saved is not made.
 */

type Saved = { url: string; title: string; favicon: string };

export type PagePersistDeps = {
  host: { onState?: (cb: (s: BrowserViewState) => void) => () => void };
  server: {
    get(browserId: string): Promise<{ url: string; title: string; favicon: string }>;
    update(browserId: string, patch: Saved): Promise<void>;
  };
  debounceMs?: number;
};

export function persistBrowserPages(d: PagePersistDeps): () => void {
  if (!d.host.onState) return () => {};
  const debounceMs = d.debounceMs ?? 500;
  /** What is saved for each browser, as last written or read: the baseline a state is compared to. */
  const saved = new Map<string, Saved>();
  /** A browser's saved row, read once, the first time it is heard from. */
  const seeding = new Map<string, Promise<void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const seed = (id: string): Promise<void> => {
    let p = seeding.get(id);
    if (!p) {
      p = d.server.get(id).then(
        (row) => { if (!saved.has(id)) saved.set(id, { url: row.url, title: row.title, favicon: row.favicon }); },
        () => { if (!saved.has(id)) saved.set(id, { url: "", title: "", favicon: "" }); }, // row gone or mid-delete
      );
      seeding.set(id, p);
    }
    return p;
  };

  const handle = (s: BrowserViewState) => {
    const before = saved.get(s.id) ?? { url: "", title: "", favicon: "" };
    const favicon = s.favicon ?? (s.url === before.url ? before.favicon : "");
    if (s.loading || s.url === "" || s.title === "") return;
    if (s.url === before.url && s.title === before.title && favicon === before.favicon) {
      clearTimeout(timers.get(s.id)); // back to what is saved: a pending write would only undo it
      timers.delete(s.id);
      return;
    }
    clearTimeout(timers.get(s.id));
    timers.set(s.id, setTimeout(() => {
      timers.delete(s.id);
      const next = { url: s.url, title: s.title, favicon };
      saved.set(s.id, next);
      void d.server.update(s.id, next).catch(() => { /* row may be mid-delete */ });
    }, debounceMs));
  };

  const off = d.host.onState((s) => { void seed(s.id).then(() => handle(s)); });
  return () => {
    off();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
