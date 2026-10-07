import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ScriptInputSchema, ScriptSchema, newId, parseScriptCommandId, scriptCommandId, scriptsKey,
  type Script, type ScriptInput,
} from "@realm/contracts";
import { NotFoundError, RpcError } from "../store/rows";
import type { SettingsStore } from "../store/settings";

/**
 * The half of `TerminalService` a script needs, as a seam rather than the class.
 *
 * Both methods exist on `TerminalService` today and are used exactly as they are — this narrows the
 * surface so the service declares what it does (open a terminal, type into it) and so a test can
 * drive it without a pty. `open` returns the item as well as the terminal because a script's run has
 * to be visible in the sidebar; a run nobody can find is a run nobody can read the output of.
 */
export type ScriptTerminals = {
  open(p: { spaceId: string; cwd: string; cols: number; rows: number }): { terminalId: string; itemId: string };
  prefill(terminalId: string, command: string): Promise<void>;
};

/** Renaming the terminal's sidebar item. Optional: an unnamed run is a run, so a missing items store
 *  costs a title and never a script. */
export type ScriptItems = { update(input: { id: string; title?: string }): unknown };

/** The size a script's terminal is spawned at, until the pane that draws it resizes it. The same
 *  80×24 `terminals.create` defaults to, so a script's output wraps where every other terminal's does. */
export const SCRIPT_TERMINAL_SIZE = { cols: 80, rows: 24 } as const;

/**
 * A space's named shell commands, and running one.
 *
 * Storage is the settings KV (`scriptsKey`) — see `ScriptSchema`'s comment for why this is a blob and
 * not a table, held to the standard `reviewResultKey` sets.
 *
 * Running one goes through `TerminalService`, and that is the whole design rather than an
 * implementation detail. A script is `pnpm test` or `pnpm dev`: the first prints output somebody has
 * to read and the second never exits. A hidden `exec` would give the first nowhere to print and the
 * second nowhere to live — so a run IS a terminal, in the sidebar, attachable, scrollable, killable
 * by the same gesture as any other.
 *
 * **The port block is not applied here.** `TerminalService.open` looks it up from the cwd already
 * (`envFor` → `portEnv`), so all a script owes its environment is a cwd that is that environment's
 * path. A second `portEnv` call in this file would be a copy that could disagree with the environment
 * the pty was actually spawned in, and it could not win: the pty is spawned by the call below, with
 * the block that call looked up. `service.test.ts` greps this file to keep the copy from appearing.
 */
export class ScriptService {
  constructor(private d: {
    settings: SettingsStore;
    /** The space's folder: the default cwd, and what a relative `cwd` resolves against. */
    spaces: { folderPathOf(spaceId: string): string | null };
    terminals: ScriptTerminals;
    items?: ScriptItems;
  }) {}

  /**
   * This space's scripts, in the order the user put them in.
   *
   * Entries are validated one at a time, so one corrupt entry costs that entry and not the space its
   * scripts — the rule `SkillsService.scopeMap` already follows about hand-editable JSON. A key that
   * is not an array at all reads as no scripts, which is what `SettingsStore.getIds` does for the
   * same reason.
   */
  list(spaceId: string): Script[] {
    const raw = this.d.settings.get(scriptsKey(spaceId));
    if (!Array.isArray(raw)) return [];
    const out: Script[] = [];
    for (const entry of raw) {
      const parsed = ScriptSchema.safeParse(entry);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  get(spaceId: string, id: string): Script | null {
    return this.list(spaceId).find((s) => s.id === id) ?? null;
  }

  /**
   * Create (no id) or update in place (an id).
   *
   * Update keeps the script's POSITION as well as its id, because both are things the user arranged:
   * a rename that sent a script to the bottom of the list would move a key binding's label out from
   * under the person who bound it.
   *
   * An id that is not in this space is a NOT_FOUND rather than a create. The client that sends one is
   * a client holding a script somebody deleted, and silently resurrecting it — under an id a keymap
   * may still point at — would be the worse of the two answers.
   */
  save(spaceId: string, input: ScriptInput): Script {
    const safe = ScriptInputSchema.safeParse(input);
    // A BAD_REQUEST rather than a ZodError escaping as INTERNAL: the RPC layer has already validated
    // the params, so anything that fails here came from a caller inside the server, and "which field"
    // is the only useful thing to say about it.
    if (!safe.success) { const i = safe.error.issues[0]; throw new RpcError("BAD_REQUEST", `script ${i?.path.join(".") || "input"}: ${i?.message ?? "is not valid"}`); }
    const parsed = safe.data;
    const scripts = this.list(spaceId);
    if (parsed.id === null) {
      const script: Script = { ...parsed, id: newId() };
      this.write(spaceId, [...scripts, script]);
      return script;
    }
    const at = scripts.findIndex((s) => s.id === parsed.id);
    if (at < 0) throw new NotFoundError("script", parsed.id);
    const script: Script = { ...parsed, id: parsed.id };
    this.write(spaceId, scripts.map((s, i) => (i === at ? script : s)));
    return script;
  }

  /** Remove one. A NOT_FOUND rather than a silent no-op: the caller is a UI that just showed a row,
   *  and "it was already gone" is a different fact from "done". */
  remove(spaceId: string, id: string): void {
    const scripts = this.list(spaceId);
    const left = scripts.filter((s) => s.id !== id);
    if (left.length === scripts.length) throw new NotFoundError("script", id);
    this.write(spaceId, left);
  }

  /** Move a script within the list. The order is the user's, so it is stored, not derived. */
  reorder(spaceId: string, ids: string[]): Script[] {
    const scripts = this.list(spaceId);
    const byId = new Map(scripts.map((s) => [s.id, s]));
    const ordered: Script[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const s = byId.get(id);
      // Unknown and repeated ids are dropped, not honoured: a client holding a stale list must not be
      // able to turn a reorder into a delete (below) or into a script listed twice (here).
      if (s && !seen.has(id)) { seen.add(id); ordered.push(s); }
    }
    // Anything the client did not mention keeps its place, at the end. Same reason.
    for (const s of scripts) if (!seen.has(s.id)) ordered.push(s);
    this.write(spaceId, ordered);
    return ordered;
  }

  /** What this space contributes to the keybinding layer: one bindable id per script, with the name
   *  to show beside the key. Ids are opaque to that layer, which is why this is the only place their
   *  shape is decided (`scriptCommandId`). */
  commands(spaceId: string): Array<{ commandId: string; name: string }> {
    return this.list(spaceId).map((s) => ({ commandId: scriptCommandId(s.id), name: s.name }));
  }

  /**
   * Run a script: a terminal in its directory, with the command typed and entered.
   *
   * The trailing newline is the difference between this and `terminals.prefill`, and it is the whole
   * point of the feature — a bound key that left `pnpm test` sitting at a prompt waiting for Return
   * would have saved the user nothing over typing it. It inherits `writeWhenQuiet`'s one caveat
   * (a shell that is ASKING something at spawn — an oh-my-zsh update prompt — is indistinguishable
   * from one at its prompt, and would be answered by the first characters instead), and here that
   * costs a mangled line that then executes rather than one that sits there.
   *
   * The clean fix is a `TerminalService` that can spawn `$SHELL -lc <command>` so there is no prompt
   * to type into at all; that is a change to a file this service does not own, and it is filed as a
   * wiring request. Until it lands the seam below is the same one every other prefill goes through.
   *
   * Always a NEW terminal, never a reuse of the last one this script opened: `pnpm dev` is still
   * running in that one, and typing a command into a live process's stdin is not re-running a script,
   * it is feeding input to a dev server.
   */
  async run(spaceId: string, id: string): Promise<{ terminalId: string; itemId: string; cwd: string }> {
    const script = this.get(spaceId, id);
    if (!script) throw new NotFoundError("script", id);
    const cwd = this.cwdFor(spaceId, script);
    // Checked here so the failure names the SCRIPT. `manager.create` would fail on the spawn with a
    // pty error about a path the user never typed — the cwd they did type is `apps/server`.
    if (!existsSync(cwd)) throw new RpcError("NOT_FOUND", `"${script.name}" has no directory at ${cwd}`);
    const opened = this.d.terminals.open({ spaceId, cwd, ...SCRIPT_TERMINAL_SIZE });
    // The script's name, not the cwd basename `TerminalService.open` auto-titles with: three scripts
    // run in one checkout would otherwise be three identical rows in the sidebar.
    try { this.d.items?.update({ id: opened.itemId, title: script.name }); } catch { /* a title is a nicety; the run is not */ }
    await this.d.terminals.prefill(opened.terminalId, `${script.command}\n`);
    return { ...opened, cwd };
  }

  /**
   * Run whatever `script.<id>.run` names, for the keybinding layer's dispatch.
   *
   * A command id that is not a script's is a BAD_REQUEST and not a NOT_FOUND: the two say different
   * things to whoever wired the binding — one is "no such script", the other is "that is not a script
   * id at all".
   *
   * `async` so that BOTH of those reject rather than one of them throwing synchronously. A dispatcher
   * that fires bindings with `.catch(report)` would otherwise let the malformed-id case escape past
   * its own error handling, which is the one case it was written for.
   */
  async runCommand(spaceId: string, commandId: string): Promise<{ terminalId: string; itemId: string; cwd: string }> {
    const id = parseScriptCommandId(commandId);
    if (!id) throw new RpcError("BAD_REQUEST", `${commandId} is not a script command id`);
    return this.run(spaceId, id);
  }

  /** Absolute cwd for a run. `resolve` covers both readings of `script.cwd` in one call: an absolute
   *  path is returned as it stands, a relative one is resolved against the space folder — never
   *  against the server's cwd, which is not a directory the user chose or can see. */
  private cwdFor(spaceId: string, script: Script): string {
    const folder = this.d.spaces.folderPathOf(spaceId);
    if (!folder) throw new NotFoundError("space", spaceId);
    return script.cwd ? resolve(folder, script.cwd) : folder;
  }

  private write(spaceId: string, scripts: Script[]): void {
    this.d.settings.set(scriptsKey(spaceId), scripts);
  }
}
