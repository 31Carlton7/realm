import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import {
  documentTemplate, isSecretPath, emptyGuideProgress, GuideProgressSchema, newId, progressSidecarPath, recordGuideAttempt,
  type DocumentEntry, type DocumentKind, type DocumentWorkspace, type GuideProgress,
} from "@realm/contracts";
import type { DocumentPreviewServer } from "./preview";
import type { Db } from "../db/database";
import type { RpcServer } from "../rpc/server";
import type { DocumentsStore } from "../store/documents";
import type { EnvironmentsStore } from "../store/environments";
import type { ItemsStore } from "../store/items";
import type { SpacesStore } from "../store/spaces";
import { NotFoundError, RpcError } from "../store/rows";
import { hashText, readDocument, readIfExists, renameDocument, writeAtomic, writeDocument, type WriteOutcome } from "./files";
import { HIDDEN_DIRS, namedFile, relInRoot, resolveInRoot } from "./paths";
import { DocumentWatcher } from "./watcher";

/**
 * Owns the document workspace: DB row + sidebar item + the filesystem underneath (Plan 17 W1).
 * Nothing else should touch the `document_workspaces` table or write a document.
 *
 * The asymmetry with `BrowserService` is the whole point of the design. A browser pane's content lives
 * in Electron main and the server persists only a URL; a document pane's content lives in **files the
 * server reads and writes**, which is what lets an agent edit a document with its ordinary Write/Edit
 * tools and have the pane show the change — with no document API on the agent side at all.
 */
export class DocumentService {
  private readonly watcher: DocumentWatcher;
  /** workspace id → the absolute paths it currently has watched. */
  private readonly byWorkspace = new Map<string, Set<string>>();
  /** absolute path → the workspace ids watching it (the refcount that decides when to stop). */
  private readonly watchers = new Map<string, Set<string>>();
  /** Files outside every root that `openPath` was asked for by name, which the pane may then read. */
  private readonly named = new Set<string>();

  constructor(private d: {
    db: Db; rpc: RpcServer; spaces: SpacesStore; items: ItemsStore;
    environments: EnvironmentsStore; documents: DocumentsStore;
    /** Plan 22: the loopback listener guides and PDFs are framed from. Optional so the unit tests
     *  that never preview need not bind a port. */
    preview?: DocumentPreviewServer;
    /** Whether a session recorded this absolute path, or a person added it to the Library
     *  (`ArtifactsStore.records`): the files outside the root this pane may READ. Absent, it reads
     *  nothing outside the root, which is what every test that never lists a file wants. */
    recorded?: (abs: string) => boolean;
  }) {
    this.watcher = new DocumentWatcher((abs, hash) => this.onFileChanged(abs, hash));
  }

  // ---------------------------------------------------------------- Plan 22: previews, opening, progress

  previewInfo(): { port: number; token: string } {
    if (!this.d.preview) throw new RpcError("UNAVAILABLE", "document previews are not available in this server");
    return this.d.preview.info();
  }

  /** The workspace root for the preview server's `rootOf` seam; null for an unknown workspace. */
  rootOfWorkspace(documentsId: string): string | null {
    const ws = this.d.documents.get(documentsId);
    if (!ws) return null;
    return this.d.environments.get(ws.environmentId)?.path ?? null;
  }

  /** A space's primary checkout — where lectures/ and guides/ live. Creates the environment row on
   *  demand, exactly as `open` does. */
  rootForSpace(spaceId: string): string {
    if (!this.d.spaces.get(spaceId)) throw new NotFoundError("space", spaceId);
    return this.d.environments.ensurePrimary(spaceId).path;
  }

  /** Let another writer (lectures, the Plynn import) tell the watcher about a file it just wrote.
   *  `null` means "I do not know the hash; treat the next event as real". */
  noteWrite(abs: string, hash: string | null): void {
    if (hash !== null) this.watcher.noteWrite(abs, hash);
  }

  /**
   * Surface one file: ensure the workspace over the environment (primary when omitted), put `path`
   * on its tab strip as the active tab, and broadcast `documents.openRequested`. The file must
   * exist — opening a tab on nothing would show an empty editor that cannot save (`baseHash` null
   * + a later creation = conflict), so a missing file is an error here rather than a surprise later.
   *
   * The path is taken as it was NAMED (`namedFile`): `~/…`, absolute, a `file://` URL, `out.md:12`, or
   * relative to `base` — the session's working directory, for a path its agent wrote — and the
   * workspace root otherwise. A file under the root is a relative tab, as every tab was; a file
   * anywhere else is an absolute one, shown read-only. That second half is what an agent's work
   * needs: what it generates lands in `/tmp`, in `~/Downloads`, in another worktree, and "outside
   * this workspace" was the refusal behind every "I can't open that for you". The deliberate limits
   * stay: a folder is not a tab, a file that exists to hold a secret (`isSecretPath`) is not opened
   * outside the root, and nothing outside the root is ever written through this pane.
   */
  async openPath(p: { spaceId: string; environmentId?: string; path: string; base?: string; openedBy?: string }): Promise<{ documentsId: string; itemId: string; environmentId: string; path: string; line: number | null }> {
    const { documentsId, itemId } = this.open({ spaceId: p.spaceId, environmentId: p.environmentId });
    const ws = this.get(documentsId);
    const root = this.rootOf(ws);
    const found = await namedFile(p.path, p.base && isAbsolute(p.base) ? p.base : root);
    if (!found) throw new RpcError("NOT_FOUND", `no such file: ${p.path}`);
    if (!found.isFile) throw new RpcError("BAD_PATH", `${p.path} is not a file`);
    const inside = relInRoot(root, found.abs);
    if (inside === null && isSecretPath(found.abs)) throw new RpcError("BAD_PATH", `${p.path} holds a secret, so Realm does not open it outside the space's folder`);
    const tab = inside ?? found.abs;
    if (inside === null) this.named.add(found.abs);
    const openPaths = ws.openPaths.includes(tab) ? ws.openPaths : [...ws.openPaths, tab];
    await this.setTabs(documentsId, openPaths, tab);
    this.d.rpc.broadcast("documents.openRequested", { spaceId: ws.spaceId, environmentId: ws.environmentId, documentsId, itemId, path: tab, ...(p.openedBy ? { openedBy: p.openedBy } : {}) });
    return { documentsId, itemId, environmentId: ws.environmentId, path: tab, line: found.line };
  }

  /** Whether this workspace may READ an absolute path outside its root: one a session recorded, or
   *  one opened by name into its tabs. The preview listener asks it for a PDF or a picture shown from
   *  outside the space. */
  readsOutside(documentsId: string, abs: string): boolean {
    const ws = this.d.documents.get(documentsId);
    return ws !== null && ws !== undefined && isAbsolute(abs) && this.mayRead(ws, abs);
  }

  /** A guide's quiz history from its sidecar; a missing or unreadable sidecar is simply empty. */
  async progressRead(documentsId: string, path: string): Promise<GuideProgress> {
    const ws = this.get(documentsId);
    const abs = resolveInRoot(this.rootOf(ws), progressSidecarPath(path));
    const cur = await readIfExists(abs);
    if (!cur) return emptyGuideProgress();
    try {
      const parsed = GuideProgressSchema.safeParse(JSON.parse(cur.text));
      return parsed.success ? parsed.data : emptyGuideProgress();
    } catch { return emptyGuideProgress(); }
  }

  /** Fold one attempt in and rewrite the sidecar. Last-writer-wins on the sidecar is fine: it is
   *  derived data with one producer (the pane), never hand-edited. */
  async progressRecord(p: { documentsId: string; path: string; topic: string; correct: number; total: number }): Promise<GuideProgress> {
    const ws = this.get(p.documentsId);
    const abs = resolveInRoot(this.rootOf(ws), progressSidecarPath(p.path));
    const prev = await this.progressRead(p.documentsId, p.path);
    const next = recordGuideAttempt(prev, p.topic, { at: Date.now(), correct: Math.min(p.correct, p.total), total: p.total });
    const text = `${JSON.stringify(next, null, 2)}\n`;
    await writeAtomic(abs, text);
    this.watcher.noteWrite(abs, hashText(text));
    return next;
  }

  // ---------------------------------------------------------------- lifecycle

  open(p: { spaceId: string; environmentId?: string }): { documentsId: string; itemId: string } {
    const space = this.d.spaces.get(p.spaceId); if (!space) throw new NotFoundError("space", p.spaceId);
    // No environment named: root at the space's own checkout, creating that row on demand. A space
    // that has never run a session has no environments at all, and "open Documents" from the sidebar
    // must still work there.
    const env = p.environmentId
      ? this.d.environments.get(p.environmentId)
      : this.d.environments.ensurePrimary(p.spaceId);
    if (!env) throw new NotFoundError("environment", p.environmentId ?? p.spaceId);
    const environmentId = env.id;

    // One workspace per environment, like `openDiff`: a second Documents pane on the same checkout
    // would be a second tab strip over the same files, with two autosaves racing on every buffer.
    // Re-opening returns the existing one and the caller focuses it.
    const existing = this.d.documents.listByEnvironment(environmentId)[0];
    if (existing) {
      const item = this.d.items.findByRefId(existing.id);
      if (item) return { documentsId: existing.id, itemId: item.id };
      // Row without an item: the item was deleted but the row survived. Re-create the item rather
      // than orphan the tabs.
      const revived = this.d.items.create({ spaceId: p.spaceId, kind: "documents", title: this.titleFor(env.path), refId: existing.id });
      this.d.rpc.broadcast("items.changed", { spaceId: p.spaceId });
      return { documentsId: existing.id, itemId: revived.id };
    }

    const documentsId = newId();
    this.d.db.exec("BEGIN");
    let itemId: string;
    try {
      this.d.documents.insert({ id: documentsId, spaceId: p.spaceId, environmentId });
      itemId = this.d.items.create({ spaceId: p.spaceId, kind: "documents", title: this.titleFor(env.path), refId: documentsId }).id;
      this.d.db.exec("COMMIT");
    } catch (e) {
      this.d.db.exec("ROLLBACK");
      throw e;
    }
    this.d.rpc.broadcast("items.changed", { spaceId: p.spaceId });
    return { documentsId, itemId };
  }

  get(documentsId: string): DocumentWorkspace {
    const row = this.d.documents.get(documentsId);
    if (!row) throw new NotFoundError("documents", documentsId);
    return row;
  }

  /** Persist the tab strip and bring the watch set in line with it. */
  async setTabs(documentsId: string, openPaths: string[], activePath: string | null): Promise<DocumentWorkspace> {
    const ws = this.get(documentsId);
    const root = this.rootOf(ws);
    // Validate every path before storing any of them — a rejected tab must not leave the strip
    // half-written.
    const abs = openPaths.map((p) => this.resolveReadable(root, p, ws));
    const updated = this.d.documents.setTabs(documentsId, openPaths, activePath);
    if (!updated) throw new NotFoundError("documents", documentsId);
    await this.syncWatches(documentsId, new Set(abs));
    return updated;
  }

  /** Drop this workspace's watches, leaving its persisted tabs alone (pane unmount). */
  detach(documentsId: string): void {
    void this.syncWatches(documentsId, new Set());
  }

  /** Delete row + item. Throws NOT_FOUND when neither exists, like BrowserService.close. */
  close(documentsId: string): void {
    const row = this.d.documents.get(documentsId);
    const item = this.d.items.findByRefId(documentsId);
    if (!row && !item) throw new NotFoundError("documents", documentsId);
    this.detach(documentsId);
    this.d.documents.delete(documentsId);
    if (item) {
      this.d.items.delete(item.id);
      this.d.rpc.broadcast("items.changed", { spaceId: item.spaceId });
    }
  }

  /** Release every watcher (server shutdown). */
  dispose(): void {
    this.watcher.close();
    this.byWorkspace.clear();
    this.watchers.clear();
  }

  // ---------------------------------------------------------------- files

  async list(documentsId: string, dir: string): Promise<DocumentEntry[]> {
    const ws = this.get(documentsId);
    const root = this.rootOf(ws);
    const absDir = resolveInRoot(root, dir);
    let names: string[];
    try {
      names = await readdir(absDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new RpcError("NOT_FOUND", `no such directory: ${dir}`);
      throw e;
    }
    const entries: DocumentEntry[] = [];
    for (const name of names) {
      if (name.startsWith(".") || HIDDEN_DIRS.has(name)) continue;
      const abs = resolveInRoot(root, dir ? `${dir}/${name}` : name);
      let st;
      // A dangling symlink or a file removed mid-listing is not an error worth failing the whole
      // directory over.
      try { st = await stat(abs); } catch { continue; }
      const rel = relInRoot(root, abs);
      if (rel === null) continue;
      entries.push({ path: rel, name, isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size });
    }
    // Directories first, then files, each alphabetical — the order a picker is read in.
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return entries;
  }

  /**
   * One file's text, for an editor to hold.
   *
   * This is the one read that refuses a file whose bytes are not text. `documentKindFor` is pure and
   * extension-driven — it has to be, since it runs on a directory listing where nothing has been read
   * — so it can say `.png` is not a document but it cannot say whether `notes.txt` is a note or a
   * renamed zip. Only the read has the bytes, so the distinction is drawn here: a NUL byte is a
   * binary and a decode failure is a file Realm would rewrite on save, and both are refused with a
   * sentence that says which. The alternative is a pane full of U+FFFD and a save that destroys the
   * file it opened.
   */
  async read(documentsId: string, path: string): Promise<{ text: string; hash: string }> {
    const ws = this.get(documentsId);
    const abs = this.resolveReadable(this.rootOf(ws), path, ws);
    const r = await readDocument(abs, { refuseBinary: true });
    // Reading is what a tab opening does, so it is also the moment the watcher must learn this file's
    // current content — otherwise the first outside edit is compared against nothing.
    this.watcher.noteWrite(abs, r.hash);
    return r;
  }

  async write(documentsId: string, path: string, text: string, baseHash: string | null): Promise<WriteOutcome> {
    const ws = this.get(documentsId);
    const abs = resolveInRoot(this.rootOf(ws), path);
    const outcome = await writeDocument(abs, text, baseHash);
    // Only a successful write changes what is on disk; recording a hash after a refused one would
    // teach the watcher a lie and suppress the very next real change.
    if (outcome.ok) this.watcher.noteWrite(abs, outcome.hash);
    return outcome;
  }

  /**
   * Rename a document and carry its tab with it.
   *
   * The tab move is the point. A rename done as "write the new file, delete the old one" would fire
   * two watch events at an open pane — a deletion and a creation — and the pane would close the tab
   * the user is looking at. Doing it here means the strip is updated in the same breath as the
   * filesystem, and the watch set follows.
   */
  async renameFile(documentsId: string, from: string, to: string): Promise<{ path: string }> {
    const ws = this.get(documentsId);
    const root = this.rootOf(ws);
    const absFrom = resolveInRoot(root, from);
    const absTo = resolveInRoot(root, to);
    await renameDocument(absFrom, absTo);
    if (from === to) return { path: to };
    // The content did not change, so the hash the watcher holds for the old path is the right one
    // for the new path — carrying it over is what stops the rename reading as an outside edit.
    const current = await readIfExists(absTo);
    if (current) this.watcher.noteWrite(absTo, current.hash);
    if (ws.openPaths.includes(from)) {
      await this.setTabs(documentsId, ws.openPaths.map((p) => (p === from ? to : p)),
        ws.activePath === from ? to : ws.activePath);
    }
    return { path: to };
  }

  async createFile(documentsId: string, path: string, kind: DocumentKind, title: string): Promise<{ path: string; hash: string }> {
    const ws = this.get(documentsId);
    const abs = resolveInRoot(this.rootOf(ws), path);
    if (await readIfExists(abs)) throw new RpcError("EXISTS", `${path} already exists`);
    const text = documentTemplate(kind, title);
    const outcome = await writeDocument(abs, text, null);
    if (!outcome.ok) throw new RpcError("EXISTS", `${path} already exists`);
    this.watcher.noteWrite(abs, outcome.hash);
    return { path, hash: hashText(text) };
  }

  // ---------------------------------------------------------------- internals

  /**
   * A path this pane may READ: one under the root, as every tab is, or the ABSOLUTE path of a file a
   * session made or was given somewhere else — another worktree's REPORT.md, a script in a scratch
   * folder — which the pane's home lists under "This session" and shows read-only.
   *
   * Read, never written: `write`, `createFile`, `renameFile` and `list` keep `resolveInRoot`, which
   * refuses every absolute path, so nothing outside the root is ever changed through this pane. The
   * match is the recorded string exactly — a `..` composed onto a recorded folder is not recorded.
   */
  private resolveReadable(root: string, path: string, ws: DocumentWorkspace): string {
    if (!isAbsolute(path) || path.includes("\0")) return resolveInRoot(root, path);
    if (!this.mayRead(ws, path)) {
      throw new RpcError("BAD_PATH", `${path} is outside this space's folder, and no session recorded it`);
    }
    return path;
  }

  /** Recorded by a session or the Library, or opened by name (`openPath`) — this run, or an earlier
   *  one whose tab is still on the strip. */
  private mayRead(ws: DocumentWorkspace, abs: string): boolean {
    return this.d.recorded?.(abs) === true || this.named.has(abs) || ws.openPaths.includes(abs);
  }

  private titleFor(envPath: string): string {
    return `Documents · ${basename(envPath) || "Space"}`;
  }

  private rootOf(ws: DocumentWorkspace): string {
    const env = this.d.environments.get(ws.environmentId);
    if (!env) throw new NotFoundError("environment", ws.environmentId);
    return env.path;
  }

  /** Bring one workspace's watch set to `want`, adding and releasing against the shared refcount. */
  private async syncWatches(documentsId: string, want: Set<string>): Promise<void> {
    const have = this.byWorkspace.get(documentsId) ?? new Set<string>();
    for (const abs of have) {
      if (want.has(abs)) continue;
      const holders = this.watchers.get(abs);
      holders?.delete(documentsId);
      if (holders && holders.size === 0) { this.watchers.delete(abs); this.watcher.unwatch(abs); }
    }
    for (const abs of want) {
      if (have.has(abs)) continue;
      let holders = this.watchers.get(abs);
      if (!holders) { holders = new Set(); this.watchers.set(abs, holders); }
      holders.add(documentsId);
      await this.watcher.watch(abs);
    }
    if (want.size === 0) this.byWorkspace.delete(documentsId);
    else this.byWorkspace.set(documentsId, want);
  }

  /**
   * One file changed. Broadcast per ENVIRONMENT, deduped: two workspaces rooted at the same checkout
   * are looking at the same file and the event names the environment, so sending it twice would make
   * every pane reload twice.
   */
  private onFileChanged(abs: string, hash: string | null): void {
    const seen = new Set<string>();
    for (const documentsId of this.watchers.get(abs) ?? []) {
      const ws = this.d.documents.get(documentsId);
      if (!ws || seen.has(ws.environmentId)) continue;
      const env = this.d.environments.get(ws.environmentId);
      if (!env) continue;
      // A file outside the root is on the strip by its absolute path, and is named by it here too.
      const rel = relInRoot(env.path, abs) ?? (ws.openPaths.includes(abs) ? abs : null);
      if (rel === null) continue;
      seen.add(ws.environmentId);
      this.d.rpc.broadcast("documents.fileChanged", { environmentId: ws.environmentId, path: rel, hash });
    }
  }
}
