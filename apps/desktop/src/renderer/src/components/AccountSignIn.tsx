import { SYSTEM_BROWSER_FRAME, type AgentSignIn } from "@realm/contracts";
import { useState } from "react";
import { Spinner } from "./Spinner";

/** Whether a sign-in is still going: started, its page up, or waiting on a code. */
export const signInLive = (s: AgentSignIn | undefined): s is AgentSignIn =>
  !!s && (s.state === "starting" || s.state === "browser" || s.state === "code");

/**
 * An account's sign-in while it runs: what it is waiting on, a field for the code if the page shows
 * one, and the page again or Cancel. The CLI's own login is what runs (`accounts.add`, `accounts.signIn`);
 * this only follows it, as the first run's card does.
 */
export function AccountSignInSteps({ signIn, name, onCode, onCancel, className }: {
  signIn: AgentSignIn; name: string; onCode: (code: string) => void; onCancel: () => void; className?: string;
}) {
  const [code, setCode] = useState("");
  const send = () => {
    const c = code.trim();
    if (c === "") return;
    setCode("");
    onCode(c);
  };
  return (
    <div className={`account-signin${className ? ` ${className}` : ""}`} aria-live="polite">
      <p className="account-signin-step">
        <Spinner size={12} />
        {signIn.state === "starting" ? `Opening the sign-in page for ${name}…` : `Finish signing in to ${name} in your browser.`}
      </p>
      {signIn.state === "code" && (
        <div className="account-signin-code">
          {/* Return here is the code's, not whatever surface the field sits on. */}
          <input className="agent-code" aria-label="Code from the sign-in page" placeholder="Paste the code if the page shows one" value={code}
            spellCheck={false} autoComplete="off" onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); send(); } }} />
          <button type="button" className="btn primary" disabled={code.trim() === ""} onClick={send}>Continue</button>
        </div>
      )}
      <span className="account-signin-actions">
        {signIn.url && <button type="button" className="btn-quiet" onClick={() => window.open(signIn.url!, SYSTEM_BROWSER_FRAME)}>Open the page again</button>}
        <button type="button" className="btn-quiet" onClick={onCancel}>Cancel</button>
      </span>
    </div>
  );
}
