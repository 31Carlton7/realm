import { useEffect, useRef, useState } from "react";
import { Icon } from "@realm/ui";
import {
  KEYCHAIN_PASSWORDS_NOTE, PASSWORDS_IMPORT_NOTE,
  type BrowserCredential, type KeychainPasswordsStatus, type PasswordFillAllow,
} from "@realm/contracts";
import { Menu } from "../../components/Menu";
import { Sheet } from "../../components/Sheet";
import { Spinner } from "../../components/Spinner";

/**
 * Settings ▸ Passwords' Realm 2.3 parts: Show, Copy and Edit on a row, Import, the login keychain, the
 * sites never offered a save, and where agents may fill without a card. Every press goes to main over
 * IPC (`main/passwords-ipc.ts`), and none of them brings a password back — Show draws it in a native
 * sheet and Copy puts it on the clipboard, both from main — so nothing an agent can read of this
 * window ever holds one. Each control carries `data-no-agent`: an agent driving Realm's window is not
 * the person these are for.
 */

const api = () => window.realm?.credentials;

/** A row's actions: Show password, Copy password, Edit…. A note beside it says what happened. */
export function PasswordRowActions({ profileId, credential, onEdit }: { profileId: string; credential: BrowserCredential; onEdit?: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const reveal = (action: "show" | "copy") => {
    setNote(null);
    void api()?.reveal?.(profileId, credential.id, action).then(
      (r) => setNote(r.ok ? (action === "copy" ? "Copied. Cleared from the clipboard in 30 seconds." : null) : r.error),
      () => setNote("That password could not be read."),
    );
  };
  const items = [
    { label: "Show password", onSelect: () => reveal("show") },
    { label: "Copy password", onSelect: () => reveal("copy") },
    ...(onEdit ? [{ label: "Edit…", onSelect: onEdit }] : []),
  ];
  return (
    <span className="password-actions" data-no-agent="saved password">
      {note !== null && <span className="share-note" role="status">{note}</span>}
      <button ref={anchor} type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Actions for ${credential.origin}`} title="Show, copy or edit" onClick={() => setOpen(true)}>
        <Icon name="more" size={14} />
      </button>
      {open && <Menu anchorRef={anchor} align="right" label={`Password for ${credential.origin}`} onClose={() => setOpen(false)} items={items} />}
    </span>
  );
}

/** Edit a saved password: its username and label, and — only when one is typed — its password. */
export function EditPasswordSheet({ profileId, credential, onClose, onSaved }: {
  profileId: string; credential: BrowserCredential; onClose: () => void; onSaved: () => void;
}) {
  const [username, setUsername] = useState(credential.username);
  const [label, setLabel] = useState(credential.label);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api()?.update?.(profileId, credential.id, { username: username.trim(), label: label.trim(), ...(value ? { value } : {}) });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That password could not be changed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={`Edit ${new URL(credential.origin).host}`} onClose={onClose} width={480}>
      <div className="form creds-form" data-no-agent="saved password">
        <label className="settings-input-label">Username
          <input type="text" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="settings-input-label">Label
          <input type="text" autoComplete="off" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="settings-input-label">New password
          <input type="password" autoComplete="new-password" placeholder="Leave empty to keep the current one" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {error !== null && <p className="settings-hint" role="alert">{error}</p>}
        <div className="sheet-actions">
          <span className="diff-head-spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => { void save(); }}>
            {busy && <Spinner size={12} />}
            Save
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/** Import… : the system's open panel in main, then counts — never a row of the file. */
export function ImportPasswordsButton({ profileId, onImported }: { profileId: string; onImported: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!api()?.import) return null;
  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api()!.import!(profileId);
      if (r.ok) {
        onImported();
        const parts = [`${r.added} added`, r.updated ? `${r.updated} updated` : "", r.unchanged ? `${r.unchanged} already saved` : "", r.skipped ? `${r.skipped} skipped` : ""].filter(Boolean);
        setNote(`Imported ${r.fileName}: ${parts.join(", ")}.${r.trashed ? " The file is in the Trash." : ""}`);
      } else if (!("cancelled" in r)) setNote(r.error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {note !== null && <span className="share-note passwords-import-note" role="status">{note}</span>}
      <button type="button" className="btn" disabled={busy} title={PASSWORDS_IMPORT_NOTE} data-no-agent="import passwords"
        onClick={() => { void run(); }}>
        {busy ? <Spinner size={12} /> : <Icon name="download" size={14} />} Import…
      </button>
    </>
  );
}

/** The login keychain: a switch, a count, and the items it offers. A Mac's alone. */
export function KeychainPasswords({ profileId }: { profileId: string }) {
  const [status, setStatus] = useState<KeychainPasswordsStatus | null>(null);
  const [rows, setRows] = useState<BrowserCredential[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void api()?.keychainStatus?.().then((s) => { if (live) setStatus(s); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!status?.enabled) { setRows([]); return; }
    let live = true;
    void api()?.keychainList?.().then((r) => { if (live) setRows(r); });
    return () => { live = false; };
  }, [status?.enabled]);
  if (!status?.supported) return null;
  const toggle = async () => {
    setBusy(true);
    try { setStatus((await api()?.setKeychain?.(!status.enabled)) ?? status); } finally { setBusy(false); }
  };
  const desc = status.error ?? (status.enabled
    ? `${status.count ?? rows.length} internet password${(status.count ?? rows.length) === 1 ? "" : "s"} offered from your login keychain.`
    : "Offer the internet passwords in your login keychain too.");
  return (
    <>
      <h3 className="settings-head" data-setting="keychain-passwords">Login keychain</h3>
      <div className="settings-group">
        <div className="settings-row" title={KEYCHAIN_PASSWORDS_NOTE} data-no-agent="keychain passwords">
          <div className="settings-row-main">
            <span className="settings-row-name">Use passwords from the login keychain</span>
            <span className="settings-row-desc">{desc}</span>
          </div>
          <input type="checkbox" role="switch" className="switch" aria-label="Use passwords from the login keychain"
            checked={status.enabled} disabled={busy} onChange={() => { void toggle(); }} />
        </div>
        {status.enabled && rows.map((c) => (
          <div key={c.id} className="settings-row" aria-label={`${c.origin}${c.username ? `: ${c.username}` : ""}`}>
            <span className="creds-mark" aria-hidden="true"><Icon name="key" size={16} /></span>
            <div className="settings-row-main">
              <span className="settings-row-name">{c.origin}</span>
              <span className="settings-row-desc">{c.username || "No username"}</span>
            </div>
            <PasswordRowActions profileId={profileId} credential={c} />
          </div>
        ))}
      </div>
    </>
  );
}

/** The sites never offered a save, and where agents may fill without a card. Shown only when there
 *  is one of either: each row is one click to put the question back. */
export function PasswordExceptions({ profileId, credentials }: { profileId: string; credentials: readonly BrowserCredential[] }) {
  const [never, setNever] = useState<string[]>([]);
  const [allows, setAllows] = useState<PasswordFillAllow[]>([]);
  useEffect(() => {
    let live = true;
    void api()?.neverList?.(profileId).then((l) => { if (live) setNever(l); });
    void api()?.fillAllows?.(profileId).then((l) => { if (live) setAllows(l); });
    return () => { live = false; };
  }, [profileId]);
  const name = (id: string) => {
    const c = credentials.find((x) => x.id === id);
    return c ? (c.username || c.origin) : "A saved password";
  };
  return (
    <>
      {allows.length > 0 && (
        <>
          <h3 className="settings-head" data-setting="agent-fill-allows">Agents fill without asking</h3>
          <div className="settings-group" data-no-agent="agent fill allows">
            {allows.map((a) => (
              <div key={`${a.credentialId}|${a.origin}`} className="settings-row" title="The card is skipped there. Touch ID, or however this profile unlocks, still applies to every fill.">
                <div className="settings-row-main">
                  <span className="settings-row-name">{name(a.credentialId)}</span>
                  <span className="settings-row-desc">On {a.origin}</span>
                </div>
                <button type="button" className="btn-quiet" onClick={() => {
                  void api()?.clearFillAllow?.(profileId, a.credentialId, a.origin).then(() => setAllows((l) => l.filter((x) => x !== a)));
                }}>Ask again</button>
              </div>
            ))}
          </div>
        </>
      )}
      {never.length > 0 && (
        <>
          <h3 className="settings-head" data-setting="never-saved">Never saved</h3>
          <div className="settings-group" data-no-agent="never saved sites">
            {never.map((origin) => (
              <div key={origin} className="settings-row">
                <div className="settings-row-main"><span className="settings-row-name">{origin}</span></div>
                <button type="button" className="btn-quiet" onClick={() => { void api()?.setNever?.(profileId, origin, false).then(setNever); }}>Remove</button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** Whether a row answers a search: its site, username or label, case-insensitive. */
export function matchesPasswordSearch(c: BrowserCredential, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || [c.origin, c.username, c.label].some((f) => f.toLowerCase().includes(q));
}
