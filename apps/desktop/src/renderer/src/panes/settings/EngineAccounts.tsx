import { useEffect, useState } from "react";
import { AGENT_META, type Account, type AccountKind } from "@realm/contracts";
import { useApp } from "../../state/store";
import { AccountSignInSteps, signInLive } from "../../components/AccountSignIn";

/**
 * An engine's accounts, on its card: each login its CLI can run on — its own folder, and every one
 * added here — with who it is and whether it is signed in, and Sign in, Rename and Remove on the row.
 * Add account makes a new folder and runs the CLI's own login in it, followed in place.
 */
export function EngineAccounts({ kind }: { kind: AccountKind }) {
  const accounts = useApp((s) => s.accounts).filter((a) => a.kind === kind);
  const refreshAccounts = useApp((s) => s.refreshAccounts);
  const addAccount = useApp((s) => s.addAccount);
  const run = useApp((s) => s.run);
  const [adding, setAdding] = useState(false);
  /** The account Add made, until its first sign-in ends: one cancelled there was never wanted. */
  const [added, setAdded] = useState<string | null>(null);
  // Asked once as the card mounts; every change after rides `accounts.changed`.
  useEffect(() => { run(() => refreshAccounts(true)); }, [run, refreshAccounts]);
  return (
    <div className="engine-accounts" role="group" aria-label={`${AGENT_META[kind].label} accounts`}>
      <ul className="engine-accounts-list">
        {accounts.map((a) => <AccountRow key={a.id} account={a} added={a.id === added} onSettled={() => setAdded(null)} />)}
      </ul>
      <button type="button" className="btn-quiet engine-accounts-add" disabled={adding}
        onClick={() => run(async () => { setAdding(true); try { setAdded(await addAccount(kind)); } finally { setAdding(false); } })}>
        Add account
      </button>
    </div>
  );
}

function AccountRow({ account: a, added, onSettled }: { account: Account; added: boolean; onSettled: () => void }) {
  const signIn = useApp((s) => s.accountSignIns[a.id]);
  const signInAccount = useApp((s) => s.signInAccount);
  const sendCode = useApp((s) => s.sendAccountSignInCode);
  const cancelSignIn = useApp((s) => s.cancelAccountSignIn);
  const renameAccount = useApp((s) => s.renameAccount);
  const removeAccount = useApp((s) => s.removeAccount);
  const run = useApp((s) => s.run);
  const [naming, setNaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const live = signInLive(signIn) ? signIn : null;
  useEffect(() => { if (added && signIn && !live) onSettled(); }, [added, signIn, live, onSettled]);
  const own = a.configDir === null;
  const state = a.signedIn === true ? "Signed in" : a.signedIn === false ? "Signed out" : null;
  const saveName = () => {
    const label = naming?.trim() ?? "";
    setNaming(null);
    if (label && label !== a.label) run(() => renameAccount(a.id, label));
  };
  return (
    <li className="engine-account" data-own={own || undefined}>
      <div className="engine-account-row">
        {naming !== null ? (
          <input className="engine-account-rename" aria-label={`Name for ${a.label}`} value={naming} autoFocus maxLength={60}
            onChange={(e) => setNaming(e.target.value)} onBlur={saveName}
            onKeyDown={(e) => { if (e.key === "Enter") saveName(); else if (e.key === "Escape") { e.stopPropagation(); setNaming(null); } }} />
        ) : (
          <span className="engine-account-name" title={own ? "The CLI's own folder" : a.configDir ?? undefined}>{a.label}</span>
        )}
        {a.email && <span className="engine-account-email">{a.email}</span>}
        {state && <span className="engine-account-state" data-tone={a.signedIn === false ? "warning" : undefined}>{state}</span>}
        <span className="engine-account-actions">
          {a.signedIn === false && !live && <button type="button" className="btn-quiet" onClick={() => run(() => signInAccount(a.id))}>Sign in</button>}
          <button type="button" className="btn-quiet" onClick={() => setNaming(a.label)}>Rename</button>
          {!own && <button type="button" className="btn-quiet danger" onClick={() => setConfirming(true)}>Remove</button>}
        </span>
      </div>
      {confirming && (
        <div className="engine-account-confirm" role="group" aria-label={`Remove ${a.label}`}>
          <p>Remove {a.label}? Realm signs it out and deletes its folder. Sessions on it move to the default account.</p>
          <span className="engine-account-actions">
            <button type="button" className="btn-quiet" onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" className="btn-quiet danger" onClick={() => { setConfirming(false); run(() => removeAccount(a.id)); }}>Remove {a.label}</button>
          </span>
        </div>
      )}
      {/* Cancelling the sign-in Add started takes back the account it made. */}
      {live && <AccountSignInSteps signIn={live} name={a.label} onCode={(code) => run(() => sendCode(a.id, code))}
        onCancel={() => run(async () => { await cancelSignIn(a.id); if (added) await removeAccount(a.id); })} />}
      {signIn?.state === "failed" && <p className="settings-hint" title={signIn.detail ?? undefined}>The sign-in didn't finish. Try again.</p>}
    </li>
  );
}
