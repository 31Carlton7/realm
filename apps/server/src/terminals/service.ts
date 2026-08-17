import { newId } from "@realm/contracts";
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
  constructor(private d: { db: Db; rpc: RpcServer; spaces: SpacesStore; items: ItemsStore; terminals: TerminalsStore }) {
    this.manager = new TerminalManager({
      onData: (terminalId, data) => d.rpc.broadcast("terminal.data", { terminalId, data }),
      onExit: (terminalId, exitCode) => {
        // Row goes; item stays so the UI can show the pane as exited until the user removes it.
        d.terminals.delete(terminalId);
        d.rpc.broadcast("terminal.exit", { terminalId, exitCode });
      },
    });
  }

  has(terminalId: string): boolean { return this.manager.has(terminalId); }

  open(p: { spaceId: string; cwd?: string; cols: number; rows: number }): { terminalId: string; itemId: string } {
    const space = this.d.spaces.get(p.spaceId); if (!space) throw new NotFoundError("space", p.spaceId);
    const cwd = p.cwd ?? space.folderPath;
    const shell = process.env.SHELL ?? "/bin/zsh";
    const terminalId = newId();
    this.d.db.exec("BEGIN");
    let itemId: string;
    try {
      this.d.terminals.insert({ id: terminalId, spaceId: p.spaceId, cwd, shell });
      itemId = this.d.items.create({ spaceId: p.spaceId, kind: "terminal", title: "Terminal", refId: terminalId }).id;
      this.manager.create({ id: terminalId, cwd, cols: p.cols, rows: p.rows, shell });
      this.d.db.exec("COMMIT");
    } catch (e) { this.d.db.exec("ROLLBACK"); throw e; }
    this.d.rpc.broadcast("items.changed", { spaceId: p.spaceId });
    return { terminalId, itemId };
  }

  write(terminalId: string, data: string): void { this.manager.write(terminalId, data); }
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
    for (const it of this.d.items.list(spaceId)) if (it.kind === "terminal") ids.add(it.refId);
    for (const id of ids) { try { this.close(id); } catch (e) { if (!(e instanceof NotFoundError)) throw e; } }
  }

  closeAll(): void { this.manager.closeAll(); }
}
