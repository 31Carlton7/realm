import { TERMINALS_HISTORY_DEFAULT, TERMINALS_HISTORY_KEY, newId } from "@realm/contracts";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Db } from "../db/database";
import type { RpcServer } from "../rpc/server";
import type { EnvironmentsStore } from "../store/environments";
import type { ItemsStore } from "../store/items";
import type { SpacesStore } from "../store/spaces";
import type { TerminalHistoryStore, TerminalsStore } from "../store/terminals";
import type { SettingsStore } from "../store/settings";
import { Scrollback, type ScrollbackCursor, type ScrollbackRead } from "./scrollback";
import { NotFoundError, RpcError } from "../store/rows";
import { portEnv } from "../workspace/ports";
import type { ExecutionSandboxService } from "../sandbox/service";
import { sandboxWrapFor, type SpawnWrap } from "../sandbox/spawn-wrap";
import { TerminalManager } from "./manager";

/**
 * Owns the terminal trio: DB row + sidebar item + pty. Nothing else should
 * touch the `terminals` table or spawn ptys directly.
 */
/** How often the in-memory buffer is written to disk, when the setting is on. A SIGKILL loses at most
 *  this much; anything shorter would be paying SQLite for output nobody has asked for yet. */
export const HISTORY_FLUSH_MS = 5_000;

/**
 * Did the execution sandbox refuse this spawn?
 *
 * Matched on the `SANDBOX_` code prefix rather than on an error class, because the codes are the
 * contract (`EXECUTION_SANDBOX_ERROR_CODES`) and a new one added there must be covered here without
 * anyone remembering to come back. `instanceof RpcError` as well as the prefix, so an ordinary Error
 * whose message merely mentions a sandbox is not mistaken for one.
 */
export const isSandboxRefusal = (e: unknown): boolean => e instanceof RpcError && e.code.startsWith("SANDBOX_");

export class TerminalService {
  readonly manager: TerminalManager;
  /** Always on, and NOT what the `terminals.history` setting gates. It holds bytes that were
   *  broadcast to every connected client anyway, and it is what makes a reattach show the output that
   *  arrived while the socket was down. The setting gates only whether it reaches disk. */
  private readonly scrollback = new Scrollback();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  constructor(private d: {
    db: Db; rpc: RpcServer; spaces: SpacesStore; items: ItemsStore; terminals: TerminalsStore;
    environments: EnvironmentsStore; history?: TerminalHistoryStore; settings?: SettingsStore;
    /** The space's Seatbelt policy, applied at `pty.spawn`. Optional so a harness built without it
     *  spawns exactly what Realm spawned before this feature existed. */
    sandbox?: ExecutionSandboxService;
    /** Injected so a test can drive the flush rather than wait for it. */
    setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  }) {
    this.manager = new TerminalManager({
      onData: (terminalId, data) => {
        const at = this.scrollback.append(terminalId, data);
        // A chunk with no ring is a chunk from a pty this service did not start — impossible through
        // `open`/`restoreAll`, which both call `newRun` first, and not worth inventing a seq for.
        if (at) d.rpc.broadcast("terminal.data", { terminalId, data, runId: at.runId, seq: at.seq });
      },
      onExit: (terminalId, exitCode) => {
        this.scrollback.endRun(terminalId);
        if (this.closed) return; // shutting down: DB may already be closed
        // Row goes; item stays so the UI can show the pane as exited until the user removes it.
        // The row going takes its scrollback with it, by the cascade — which is why a shell that
        // exited before a restart restores exactly as it always has, as a pane that is not running.
        try { d.terminals.delete(terminalId); } catch (e) {
          if ((e as { code?: string }).code !== "ERR_INVALID_STATE") throw e;
        }
        d.rpc.broadcast("terminal.exit", { terminalId, exitCode });
      },
    });
    const every = d.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.flushTimer = every(() => this.flushHistory(), HISTORY_FLUSH_MS);
    // Node keeps the process alive for a pending interval; this one must not be the reason a daemon
    // with nothing to do refuses to exit.
    this.flushTimer.unref?.();
  }

  /** Whether scrollback reaches disk. Read at use rather than cached: a switch flipped in Settings
   *  takes effect on the next flush, with nothing to restart. */
  private get historyEnabled(): boolean {
    const raw = this.d.settings?.get(TERMINALS_HISTORY_KEY);
    return raw === undefined || raw === null ? TERMINALS_HISTORY_DEFAULT : raw === true;
  }

  /** Write every live terminal's buffer to disk. A no-op — and a purge is NOT done here — when the
   *  setting is off; `settings.set` owns the purge, because turning it off should not wait for a tick. */
  flushHistory(): void {
    if (this.closed || !this.d.history || !this.historyEnabled) return;
    for (const id of this.scrollback.ids()) {
      const snap = this.scrollback.snapshot(id);
      if (!snap || snap.data === "") continue;
      // A terminal whose row is gone has no history row to own: the foreign key would refuse it, and
      // the pane it belonged to is already showing as not running.
      if (!this.d.terminals.get(id)) continue;
      try { this.d.history.put({ terminalId: id, ...snap }); } catch (e) {
        console.error(`[terminals] could not write scrollback for ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Turning the setting off. The in-memory buffers stay — they are not what the switch gates — and
   *  everything on disk goes. */
  purgeHistory(): void {
    this.d.history?.deleteAll();
  }

  /** What this client is missing, plus the screen that came before it. See `Scrollback.read`. */
  read(terminalId: string, cursor: ScrollbackCursor | null): ScrollbackRead {
    const r = this.scrollback.read(terminalId, cursor);
    if (r) return r;
    // A terminal this service knows nothing about — closed, or never restored. Answering rather than
    // throwing keeps the renderer on one path: a pane that is not running looks the same either way.
    return { runId: "", seq: 0, live: "", truncated: false, running: false, history: null };
  }

  has(terminalId: string): boolean { return this.manager.has(terminalId); }

  /**
   * The environment variables a shell in this cwd is spawned with: its environment's port block
   * (W2), so `pnpm dev` typed into a worktree's terminal lands on that worktree's ports rather than
   * on :3000 alongside two other agents.
   *
   * Looked up by path rather than passed in, so `restoreAll` gives a respawned pty the same block it
   * had before the restart — the block is a column, and nothing here reallocates it. A cwd with no
   * environment (a terminal opened somewhere ad hoc) simply gets nothing extra.
   */
  private envFor(spaceId: string, cwd: string): Record<string, string> {
    const env = this.d.environments.findByPath(spaceId, cwd);
    // `REALM_SANDBOX`/`REALM_SANDBOX_NETWORK` ride along beside the port block. They are a
    // STATEMENT, not a control — nothing reads them back — so that "why did this write fail" has a
    // visible cause in the shell it failed in rather than only in Settings.
    return { ...(env ? portEnv(env) : {}), ...this.d.sandbox?.env(spaceId) };
  }

  /** The Seatbelt wrapper a shell in this space is spawned through, or `undefined` when it has no
   *  sandbox. No `extraWritableRoots`: a terminal's cwd is a directory of the space, and the space's
   *  checkouts are already writable — unlike a session, which can be pointed at a folder Realm has
   *  not catalogued. See `sandboxWrapFor` for why `undefined` and not an identity function. */
  private wrapFor(spaceId: string): SpawnWrap | undefined {
    return sandboxWrapFor(this.d.sandbox, { spaceId });
  }

  /** Boot: respawn a pty for every persisted terminal row. Rows whose cwd vanished or whose spawn fails
   *  are deleted (the item stays, so the UI can show the pane as not running). Returns ids restored. */
  restoreAll(): string[] {
    const restored: string[] = [];
    for (const row of this.d.terminals.listAll()) {
      if (this.manager.has(row.id)) continue;
      try {
        if (!existsSync(row.cwd)) throw new Error(`cwd missing: ${row.cwd}`);
        const kept = this.d.history?.get(row.id) ?? null;
        // The size the output was PRINTED at, not a default. A replayed 120-column screen above a
        // fresh 80-column shell is a ragged seam nobody would blame on the pty's default width.
        const cols = kept?.cols ?? 80, rows = kept?.rows ?? 24;
        // Before `create`, always: a shell can print its prompt before that call returns, and a chunk
        // appended to no ring is a chunk that never happened.
        this.scrollback.newRun(row.id, newId(), { cols, rows }, kept ? { data: kept.data, cols: kept.cols, rows: kept.rows } : null);
        this.manager.create({ id: row.id, cwd: row.cwd, shell: row.shell, cols, rows, env: this.envFor(row.spaceId, row.cwd), wrap: this.wrapFor(row.spaceId) });
        restored.push(row.id);
      } catch (e) {
        console.error(`[terminals] not restoring ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
        this.scrollback.forget(row.id);
        // A sandbox refusal is TEMPORARY and it is not about this row. `sandbox-exec` gone on this
        // boot, or a posture the user is about to change, would otherwise reach the delete below
        // and take EVERY persisted terminal in every space with it — the whole feature's worst
        // failure mode, and one that looks like data loss rather than like a refusal. So the row
        // stays, un-restored: the pane draws as not running, and the next boot (or the next
        // `terminals.create`) tries again.
        //
        // Narrow on purpose. Everything else — a cwd that no longer exists, a shell that will not
        // start — is a fact about THIS row that will not change by waiting, and keeps the pruning
        // behaviour it has always had.
        if (isSandboxRefusal(e)) continue;
        this.d.terminals.delete(row.id);
      }
    }
    return restored;
  }

  open(p: { spaceId: string; cwd?: string; cols: number; rows: number }): { terminalId: string; itemId: string } {
    const space = this.d.spaces.get(p.spaceId); if (!space) throw new NotFoundError("space", p.spaceId);
    const cwd = p.cwd ?? space.folderPath;
    const shell = process.env.SHELL ?? "/bin/zsh";
    const terminalId = newId();
    this.d.db.exec("BEGIN");
    let itemId: string;
    try {
      this.d.terminals.insert({ id: terminalId, spaceId: p.spaceId, cwd, shell });
      // Auto-title from the cwd basename (U-M1) so several terminals stay tellable-apart; "/" has no
      // basename, so it falls back to the generic label.
      itemId = this.d.items.create({ spaceId: p.spaceId, kind: "terminal", title: basename(cwd) || "Terminal", refId: terminalId }).id;
      // Before `create`, for `restoreAll`'s reason: the shell can print before the call returns.
      this.scrollback.newRun(terminalId, newId(), { cols: p.cols, rows: p.rows }, null);
      this.manager.create({ id: terminalId, cwd, cols: p.cols, rows: p.rows, shell, env: this.envFor(p.spaceId, cwd), wrap: this.wrapFor(p.spaceId) });
      this.d.db.exec("COMMIT");
    } catch (e) {
      this.d.db.exec("ROLLBACK");
      this.scrollback.forget(terminalId);
      if (this.manager.has(terminalId)) { try { this.manager.close(terminalId); } catch { /* best effort */ } }
      throw e;
    }
    this.d.rpc.broadcast("items.changed", { spaceId: p.spaceId });
    return { terminalId, itemId };
  }

  write(terminalId: string, data: string): void { this.manager.write(terminalId, data); }
  /** Type `command` into the terminal once its shell settles. No trailing newline — the user presses Return. */
  prefill(terminalId: string, command: string): Promise<void> { return this.manager.writeWhenQuiet(terminalId, command); }
  resize(terminalId: string, cols: number, rows: number): void {
    this.manager.resize(terminalId, cols, rows);
    this.scrollback.resize(terminalId, cols, rows);
  }

  /** Kill the pty (if still alive), delete the row and the item. Throws NOT_FOUND if none of the three exist. */
  close(terminalId: string): void {
    const row = this.d.terminals.get(terminalId);
    const item = this.d.items.findByRefId(terminalId);
    const alive = this.manager.has(terminalId);
    if (!row && !item && !alive) throw new NotFoundError("terminal", terminalId);
    if (alive) this.manager.close(terminalId);
    this.scrollback.forget(terminalId);
    // The cascade takes the history row with the terminals row; this is for the case where the row
    // was already gone (pty exit) and the scrollback outlived it in memory.
    this.d.history?.delete(terminalId);
    this.d.terminals.delete(terminalId);
    if (item) {
      this.d.items.delete(item.id);
      this.d.rpc.broadcast("items.changed", { spaceId: item.spaceId });
    }
  }

  /** Re-home the row when a session terminal rides along with `sessions.moveToSpace`. Row only: the
   *  pty stays exactly as it is, because the session carried its checkout across and the cwd the
   *  shell was spawned at is unchanged. The item half is moved by the caller, inside its transaction. */
  moveToSpace(terminalId: string, spaceId: string): void {
    this.d.terminals.moveToSpace(terminalId, spaceId);
  }

  /** Close every terminal whose row or item belongs to the space (used before space deletion). */
  closeAllInSpace(spaceId: string): void {
    const ids = new Set<string>();
    for (const r of this.d.terminals.listBySpace(spaceId)) ids.add(r.id);
    // Hidden (session-owned) terminals count too — hence listIncludingHidden, not list. Belt and
    // braces today: every LIVE session terminal is already reached through the rows above, and the only
    // caller (spaces.delete) cascades the items anyway. It keeps this method honest to its name.
    for (const it of this.d.items.listIncludingHidden(spaceId)) if (it.kind === "terminal") ids.add(it.refId);
    for (const id of ids) { try { this.close(id); } catch (e) { if (!(e instanceof NotFoundError)) throw e; } }
  }

  /** Shutdown: kill ptys but intentionally keep rows/items (unlike close(), which removes them).
   *  The synchronous flush FIRST — this is the write that makes a clean quit lose nothing, and after
   *  `closed` is set the periodic one refuses. */
  closeAll(): void {
    this.flushHistory();
    this.closed = true;
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    this.manager.closeAll();
  }
}
