import { newId } from "@realm/contracts";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Db } from "../db/database";
import type { RpcServer } from "../rpc/server";
import type { ItemsStore } from "../store/items";
import type { SpacesStore } from "../store/spaces";
import type { TerminalsStore } from "../store/terminals";
import { NotFoundError } from "../store/rows";
import { TerminalManager } from "./manager";

/**
 * Owns the terminal trio: DB row + sidebar item + pty. Nothing else should
 * touch the `terminals` table or spawn ptys directly.
 */
export class TerminalService {
  readonly manager: TerminalManager;
  private closed = false;
  constructor(private d: { db: Db; rpc: RpcServer; spaces: SpacesStore; items: ItemsStore; terminals: TerminalsStore }) {
    this.manager = new TerminalManager({
      onData: (terminalId, data) => d.rpc.broadcast("terminal.data", { terminalId, data }),
      onExit: (terminalId, exitCode) => {
        if (this.closed) return; // shutting down: DB may already be closed
        // Row goes; item stays so the UI can show the pane as exited until the user removes it.
        try { d.terminals.delete(terminalId); } catch (e) {
          if ((e as { code?: string }).code !== "ERR_INVALID_STATE") throw e;
        }
        d.rpc.broadcast("terminal.exit", { terminalId, exitCode });
      },
    });
  }

  has(terminalId: string): boolean { return this.manager.has(terminalId); }

  /** Boot: respawn a pty for every persisted terminal row. Rows whose cwd vanished or whose spawn fails
   *  are deleted (the item stays, so the UI can show the pane as not running). Returns ids restored. */
  restoreAll(): string[] {
    const restored: string[] = [];
    for (const row of this.d.terminals.listAll()) {
      if (this.manager.has(row.id)) continue;
      try {
        if (!existsSync(row.cwd)) throw new Error(`cwd missing: ${row.cwd}`);
        this.manager.create({ id: row.id, cwd: row.cwd, shell: row.shell, cols: 80, rows: 24 });
        restored.push(row.id);
      } catch (e) {
        console.error(`[terminals] not restoring ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
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
      this.manager.create({ id: terminalId, cwd, cols: p.cols, rows: p.rows, shell });
      this.d.db.exec("COMMIT");
    } catch (e) {
      this.d.db.exec("ROLLBACK");
      if (this.manager.has(terminalId)) { try { this.manager.close(terminalId); } catch { /* best effort */ } }
      throw e;
    }
    this.d.rpc.broadcast("items.changed", { spaceId: p.spaceId });
    return { terminalId, itemId };
  }

  write(terminalId: string, data: string): void { this.manager.write(terminalId, data); }
  /** Type `command` into the terminal once its shell settles. No trailing newline — the user presses Return. */
  prefill(terminalId: string, command: string): Promise<void> { return this.manager.writeWhenQuiet(terminalId, command); }
  resize(terminalId: string, cols: number, rows: number): void { this.manager.resize(terminalId, cols, rows); }

  /** Kill the pty (if still alive), delete the row and the item. Throws NOT_FOUND if none of the three exist. */
  close(terminalId: string): void {
    const row = this.d.terminals.get(terminalId);
    const item = this.d.items.findByRefId(terminalId);
    const alive = this.manager.has(terminalId);
    if (!row && !item && !alive) throw new NotFoundError("terminal", terminalId);
    if (alive) this.manager.close(terminalId);
    this.d.terminals.delete(terminalId);
    if (item) {
      this.d.items.delete(item.id);
      this.d.rpc.broadcast("items.changed", { spaceId: item.spaceId });
    }
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

  /** Shutdown: kill ptys but intentionally keep rows/items (unlike close(), which removes them). */
  closeAll(): void { this.closed = true; this.manager.closeAll(); }
}
