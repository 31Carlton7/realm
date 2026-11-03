import { SYSTEM_BROWSER_FRAME, type AgentSignIn } from "@realm/contracts";
import { useState } from "react";

/** Whether a sign-in is still going: started, its page up, or waiting on a code. */
export const signInLive = (s: AgentSignIn | undefined): s is AgentSignIn =>
  !!s && (s.state === "starting" || s.state === "browser" || s.state === "code");

/**
 * An account's sign-in while it runs, as one panel: what it is waiting on, a field for the code if the
 * page shows one, and the page again, Cancel and Continue along its foot. The CLI's own login is what
 * runs (`accounts.add`, `accounts.signIn`); this only follows it, as the first run's card does.
 */
export function AccountSignInSteps({ signIn, name, onCode, onCancel }: {
  signIn: AgentSignIn; name: string; onCode: (code: string) => void; onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const send = () => {
    const c = code.trim();
    if (c === "") return;
    setCode("");
    onCode(c);
  };
  const asksForCode = signIn.state === "code";
  return (
    <div className="account-signin" aria-live="polite">
      <p className="account-signin-step">
        <span key={signIn.state} className="shimmer-text">
          {signIn.state === "starting" ? `Opening the sign-in page for ${name}…` : `Finish signing in to ${name} in your browser.`}
        </span>
      </p>
      {asksForCode && (
        // Return here is the code's, not whatever surface the field sits on.
        <input className="agent-code account-signin-code" aria-label="Code from the sign-in page" placeholder="Code, if the page shows one" value={code}
          spellCheck={false} autoComplete="off" onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); send(); } }} />
      )}
      <div className="account-signin-actions">
        {signIn.url && <button type="button" className="btn-quiet" title="Open the sign-in page again"
          onClick={() => window.open(signIn.url!, SYSTEM_BROWSER_FRAME)}>Open again</button>}
        <button type="button" className="btn-quiet" onClick={onCancel}>Cancel</button>
        {asksForCode && <button type="button" className="btn primary" disabled={code.trim() === ""} onClick={send}>Continue</button>}
      </div>
    </div>
  );
}
