import type { AgentSignIn } from "@realm/contracts";
import { useState } from "react";
import { useApp } from "../state/store";
import { Spinner } from "./Spinner";

/**
 * `signIn` while it is still running, which is while its steps are drawn: started, with its page
 * up, or asking for the page's code. Null once it has ended, however it ended, and where there is
 * none.
 */
export function runningSignIn(signIn: AgentSignIn | null | undefined): AgentSignIn | null {
  return signIn && (signIn.state === "starting" || signIn.state === "browser" || signIn.state === "code") ? signIn : null;
}

/**
 * A space-less sign-in while it runs (`agentSignIn.*`): what the CLI is waiting on, a field for the
 * code its page may show, the way back to that page, and Cancel. A first-run card draws it for its
 * own agent, and a profile's page draws it for the Claude config folder that profile names.
 *
 * The browser leads, and the code field comes second. Claude asks for a code in the same breath as
 * it prints the page, but the browser tab it opened itself finishes on its own, and only the page
 * reached by Open the page again shows a code. So the field is there for whoever needs it, under
 * the line that says where the sign-in is finished.
 *
 * Enter in the code field sends the code and does nothing else. On the first run the field stands
 * inside the page's one form, and Enter would otherwise submit the whole page and start before the
 * code went in.
 *
 * `signIn` is one that is still running (`runningSignIn`), and `name` is the agent's, for the
 * field's accessible name. The code typed is the block's own, so it goes with the sign-in it was
 * typed for. That holds because whoever draws the block keys it by the sign-in's id: a second
 * sign-in taking the first one's place is then a new block, with an empty field.
 */
export function AgentSignInSteps({ signIn, name }: { signIn: AgentSignIn; name: string }) {
  const sendAgentSignInCode = useApp((s) => s.sendAgentSignInCode);
  const cancelAgentSignIn = useApp((s) => s.cancelAgentSignIn);
  const run = useApp((s) => s.run);
  const [code, setCode] = useState("");
  const { kind, state, url } = signIn;
  const sendCode = () => {
    const c = code.trim();
    if (c === "") return;
    setCode("");
    run(() => sendAgentSignInCode(kind, c));
  };
  return (
    <div className="agent-card-signin">
      <span className="agent-card-status" data-busy>
        <Spinner size={12} />
        {state === "starting" ? "Opening the sign-in page…" : "Finish signing in in your browser."}
      </span>
      {state === "code" && (
        <>
          <span className="agent-card-note">If the page shows a code, paste it here.</span>
          <div className="agent-code-row">
            <input className="agent-code" aria-label={`Code from ${name}'s sign-in page`} value={code}
              spellCheck={false} autoComplete="off" onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendCode(); } }} />
            <button type="button" className="btn primary" disabled={code.trim() === ""} onClick={sendCode}>Continue</button>
          </div>
        </>
      )}
      <span className="agent-card-actions">
        {url && (
          <button type="button" className="btn-quiet" onClick={() => window.open(url, "_blank")}>Open the page again</button>
        )}
        <button type="button" className="btn-quiet" onClick={() => run(() => cancelAgentSignIn(kind))}>Cancel</button>
      </span>
    </div>
  );
}
