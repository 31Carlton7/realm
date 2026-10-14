import { describe, expect, it } from "vitest";
import { PASSWORD_CLIPBOARD_CLEAR_MS } from "@realm/contracts";
import { registerPasswordsIpc, type PasswordsIpcDeps } from "./passwords-ipc";
import { SecretStore } from "./secret-store";

/**
 * The mutants:
 *   - Show or Copy answering the renderer with the password;
 *   - the clipboard cleared over something the person copied since, or never cleared;
 *   - an import whose answer quotes the file, or that leaves the file without asking.
 */

const SECRET = "correct horse battery staple";
const P = "pPersonal";

function harness(over: Partial<PasswordsIpcDeps> = {}) {
  let disk: string | null = null;
  const store = new SecretStore({
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`kc:${s}`), decryptString: (b) => b.toString().slice(3) },
    readFile: () => disk, writeFile: (t) => { disk = t; }, appendAudit: () => {},
    promptPresence: async () => true, promptDeviceOwner: async () => true, canPromptDeviceOwner: () => true,
    now: () => 1, newId: (() => { let n = 0; return () => `c${++n}`; })(), defaultProfileId: () => P,
  });
  const handlers = new Map<string, (sender: unknown, ...args: unknown[]) => unknown>();
  const board = { text: "", cleared: 0 };
  const timers: (() => void)[] = [];
  const shown: string[] = [];
  const files = new Map<string, string>();
  const trashed: string[] = [];
  registerPasswordsIpc({
    handle: (channel, fn) => { handlers.set(channel, fn); },
    secrets: () => store,
    resolveProfile: async (id) => (id === P ? { id } : null),
    pickExport: async () => "/Users/x/Passwords.csv",
    readFile: async (path) => ({ size: files.get(path)?.length ?? 0, text: async () => files.get(path) ?? "" }),
    offerToTrash: async (_s, path) => { trashed.push(path); return true; },
    showPassword: async (_s, _title, value) => { shown.push(value); return false; },
    clipboard: { writeText: (t) => { board.text = t; }, readText: () => board.text, clear: () => { board.text = ""; board.cleared++; } },
    setTimer: (fn, ms) => { expect(ms).toBe(PASSWORD_CLIPBOARD_CLEAR_MS); timers.push(fn); },
    ...over,
  });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { store, call, board, timers, shown, files, trashed };
}

describe("Show and Copy", () => {
  it("never answer the renderer with the password", async () => {
    const h = harness();
    const row = h.store.addCredential(P, { origin: "https://example.com", username: "ada", label: "", value: SECRET });
    const shown = await h.call("credentials:reveal", P, row.id, "show");
    const copied = await h.call("credentials:reveal", P, row.id, "copy");
    expect(shown).toEqual({ ok: true });
    expect(copied).toEqual({ ok: true });
    expect(JSON.stringify([shown, copied])).not.toContain(SECRET);
    expect(h.shown).toEqual([SECRET]);
    expect(h.board.text).toBe(SECRET);
  });

  it("clears the clipboard after the wait — unless the person copied something else", async () => {
    const h = harness();
    const row = h.store.addCredential(P, { origin: "https://example.com", username: "ada", label: "", value: SECRET });
    await h.call("credentials:reveal", P, row.id, "copy");
    h.timers.shift()!();
    expect(h.board.text).toBe("");
    await h.call("credentials:reveal", P, row.id, "copy");
    h.board.text = "something of theirs";
    h.timers.shift()!();
    expect(h.board.text).toBe("something of theirs");
    expect(h.board.cleared).toBe(1);
  });
});

describe("import", () => {
  it("answers with counts, and offers to trash the file", async () => {
    const h = harness();
    h.files.set("/Users/x/Passwords.csv", `Title,URL,Username,Password,Notes,OTPAuth\nA,https://a.example.com,ada,${SECRET},,\nApp,android://x,u,p,,\n`);
    const r = await h.call("credentials:import", P);
    expect(r).toEqual({ ok: true, added: 1, updated: 0, unchanged: 0, skipped: 1, fileName: "Passwords.csv", trashed: true });
    expect(JSON.stringify(r)).not.toMatch(/ada|a\.example|correct/);
    expect(h.trashed).toEqual(["/Users/x/Passwords.csv"]);
    expect(h.store.listCredentials(P)).toHaveLength(1);
  });

  it("does nothing and trashes nothing when the person cancels or the file is not an export", async () => {
    const cancelled = harness({ pickExport: async () => null });
    expect(await cancelled.call("credentials:import", P)).toEqual({ ok: false, cancelled: true });
    const h = harness();
    h.files.set("/Users/x/Passwords.csv", "a,b\n1,2\n");
    expect((await h.call("credentials:import", P) as { ok: boolean }).ok).toBe(false);
    expect(h.trashed).toEqual([]);
  });
});
