import { SYSTEM_BROWSER_FRAME, type McpServer, type McpSignInOptions } from "@realm/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Sheet } from "../Sheet";
import { useApp } from "../../state/store";

type Device = { userCode: string; verificationUri: string } | { error: string } | "starting" | null;

/**
 * The ways in to a server that issues no client on the fly, as Chrome and VS Code sign in to GitHub:
 * the sign-in the GitHub CLI already has, a code typed on GitHub's own page (device flow, only once
 * Realm has an app registered for it), a token pasted here, or an app of the user's own. Each is
 * one button; the first that can work right now is the primary one.
 *
 * `reason` is the server's refusal, shown only when the sheet opened because Connect could not
 * start — the same sheet opened from "Use a token instead" has nothing to apologise for.
 */
export function McpSignInSheet({ server, reason, onClose }: { server: McpServer; reason?: string; onClose: () => void }) {
  const mcpSignInOptions = useApp((s) => s.mcpSignInOptions);
  const [options, setOptions] = useState<McpSignInOptions | null>(null);
  const load = useCallback(() => {
    let live = true;
    // A failed read is a server Realm knows nothing about: a token and an app are still possible.
    void mcpSignInOptions(server.id).then((o) => { if (live) setOptions(o); })
      .catch(() => { if (live) setOptions({ provider: null, cli: null, device: false, token: null }); });
    return () => { live = false; };
  }, [server.id, mcpSignInOptions]);
  useEffect(load, [load]);

  const name = options?.provider ?? server.name;
  return (
    <Sheet title={`Connect ${name}`} onClose={onClose} width={480}>
      {options && <SignInRoutes server={server} options={options} reason={reason} recheck={load} onDone={onClose} />}
    </Sheet>
  );
}

function SignInRoutes({ server, options, reason, recheck, onDone }: { server: McpServer; options: McpSignInOptions; reason?: string; recheck: () => void; onDone: () => void }) {
  const run = useApp((s) => s.run);
  const connectMcpWithCli = useApp((s) => s.connectMcpWithCli);
  const setMcpToken = useApp((s) => s.setMcpToken);
  const startMcpDevice = useApp((s) => s.startMcpDevice);
  const waitMcpDevice = useApp((s) => s.waitMcpDevice);
  const setMcpOauthClient = useApp((s) => s.setMcpOauthClient);
  const beginMcpSignIn = useApp((s) => s.beginMcpSignIn);
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [device, setDevice] = useState<Device>(null);

  const cliReady = options.cli?.state === "ready";
  // One primary: the route that works with nothing typed, the CLI before the browser.
  const primary = cliReady ? "cli" : options.device ? "device" : "token";

  const connectCli = () => run(async () => { await connectMcpWithCli(server.id); onDone(); });
  // Both forms stop the submit here: the sheet is portalled out of the DOM, but React still bubbles
  // a synthetic submit to the server editor's own <form> it was opened from, which would save it.
  const connectToken = (e: FormEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (token.trim()) run(async () => { await setMcpToken(server.id, token.trim()); onDone(); });
  };
  const connectDevice = () => {
    setDevice("starting");
    run(async () => {
      try {
        const code = await startMcpDevice(server.id);
        setDevice(code);
        // GitHub's page, in the person's own browser where they are already signed in.
        window.open(code.verificationUri, SYSTEM_BROWSER_FRAME);
        await waitMcpDevice(server.id);
        onDone();
      } catch (e) {
        setDevice({ error: e instanceof Error ? e.message : String(e) });
      }
    });
  };
  const connectOwnApp = (e: FormEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (!clientId.trim()) return;
    run(async () => {
      await setMcpOauthClient(server.id, { clientId: clientId.trim(), clientSecret: clientSecret.trim() || undefined, relay: false });
      const started = await beginMcpSignIn(server.id);
      if (started.kind === "browser") window.open(started.authUrl, SYSTEM_BROWSER_FRAME);
      onDone();
    });
  };

  const provider = options.provider;
  return (
    <div className="form signin-routes">
      {reason && <p className="settings-note">{provider
        ? `${provider} issues no client to apps it has not met, so there is no browser sign-in to start. Sign in one of these ways instead.`
        : `${server.name} issues no client to apps it has not met. Give Realm a token it accepts, or an app of your own.`}</p>}

      {options.cli && (
        <section className="field signin-route" aria-label={options.cli.name}>
          <span>{options.cli.name}</span>
          {cliReady
            ? <p className="signin-hint">Uses the account gh is signed in to. If {provider ?? "the server"} stops accepting it, Realm asks gh again.</p>
            : <p className="signin-hint">{options.cli.state === "missing"
                ? <>The GitHub CLI is not installed. Install it (<code>brew install gh</code>), run <code>gh auth login</code>, then check again.</>
                : <>The GitHub CLI is not signed in. Run <code>gh auth login</code> in a terminal, then check again.</>}</p>}
          <div className="form-actions signin-actions">
            {cliReady
              ? <button type="button" className={primary === "cli" ? "btn primary" : "btn"} onClick={connectCli}>Sign in with the {options.cli.name}</button>
              : <button type="button" className="btn" onClick={recheck}>Check again</button>}
          </div>
        </section>
      )}

      {options.device && (
        <section className="field signin-route" aria-label={`Sign in with ${provider}`}>
          <span>{provider} in your browser</span>
          {device && typeof device === "object" && "userCode" in device
            ? <>
                <p className="signin-hint">Enter this code on the page that opened. Realm connects as soon as you approve.</p>
                <div className="signin-code-row">
                  <output className="signin-code" aria-label="Code to enter">{device.userCode}</output>
                  <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(device.userCode)}>Copy</button>
                  <button type="button" className="btn-quiet" onClick={() => window.open(device.verificationUri, SYSTEM_BROWSER_FRAME)}>Open the page again</button>
                </div>
              </>
            : <>
                {device && typeof device === "object" && <p className="mcp-error">{device.error}</p>}
                <p className="signin-hint">Shows a code to enter on {provider}'s own page, where you are already signed in.</p>
                <div className="form-actions signin-actions">
                  <button type="button" className={primary === "device" ? "btn primary" : "btn"} disabled={device === "starting"} onClick={connectDevice}>
                    {device && typeof device === "object" ? "Start again" : `Sign in with ${provider}`}
                  </button>
                </div>
              </>}
        </section>
      )}

      <form className="field signin-route" onSubmit={connectToken} aria-label="Paste a token">
        <span>{provider ? "Personal access token" : "Token"}</span>
        <input aria-label="Token" type="password" value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} autoComplete="off" />
        <p className="signin-hint">
          Sent as a Bearer token and stored sealed with this server's sign-in; the agent never receives it.
          {options.token && <> <a className="market-docs" href={options.token.url} target="_blank" rel="noreferrer">Create one on {provider}</a> with <code>{options.token.scopes}</code>.</>}
        </p>
        <div className="form-actions signin-actions">
          <button type="submit" className={primary === "token" ? "btn primary" : "btn"} disabled={!token.trim()}>Connect with this token</button>
        </div>
      </form>

      <details className="signin-route signin-app">
        <summary>Use an OAuth app of your own</summary>
        <form className="form" onSubmit={connectOwnApp}>
          <p className="signin-hint">Register an app with {provider ?? server.name} whose callback URL is <code>http://127.0.0.1/oauth/callback</code>, and paste what it gives you.</p>
          <label className="field"><span>Client ID</span>
            <input aria-label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} /></label>
          <label className="field"><span>Client secret</span>
            <input aria-label="Client secret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></label>
          <div className="form-actions signin-actions">
            <button type="submit" className="btn" disabled={!clientId.trim()}>Continue in the browser</button>
          </div>
        </form>
      </details>
    </div>
  );
}
