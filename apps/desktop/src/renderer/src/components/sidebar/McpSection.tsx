import { MCP_SECRET_STORAGE_NOTE, mcpSupportNote, type AgentKind, type McpServer, type McpServerStatus, type McpTransport } from "@realm/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { useApp } from "../../state/store";

const STATUS_LABEL: Record<McpServerStatus, string> = {
  idle: "Idle", connected: "Connected", error: "Error", circuit_open: "Circuit open",
};
/** Binding note 1 (W5 review): mid-session token expiry surfaces as failing calls → circuit_open, and
 *  Retry is the one-click fix (it reconnects AND silently refreshes OAuth). The copy has to say both. */
const CIRCUIT_OPEN_COPY = "This server's connection keeps failing, so calls are blocked. Retry reconnects and refreshes the connection.";
const isAcpKind = (k: AgentKind) => k.startsWith("acp:");

/** One row of a server's env/header secrets being entered — new key/value pairs only. Existing keys are
 *  named (never their values, which Realm never receives back) so touching this section is an honest
 *  "replace everything below" rather than a merge nobody can verify. */
type SecretRow = { key: string; value: string };

/**
 * MCP servers, auth and per-space/per-tool policy — rendered inside `SpaceSettingsSheet` below
 * `EnvironmentList`, following its idiom (`useApp`, `run()`, `.field` sections, no new component
 * patterns). This is the first MCP settings UI Realm has ever had (W1–W5 built only the engine).
 *
 * Every state here has to say something, per the plan's honesty rule: a server with no cached tools
 * names the action that would get it some; a blocked circuit names its own fix; a secret field never
 * lets the user forget where the value is going.
 */
export function McpSection({ spaceId }: { spaceId: string }) {
  const servers = useApp((s) => s.mcpServers);
  const sessions = useApp((s) => s.sessions);
  const refreshMcpServers = useApp((s) => s.refreshMcpServers);
  const run = useApp((s) => s.run);
  const [adding, setAdding] = useState(false);

  // Fetch on sheet open: McpSection only ever mounts while the space-settings sheet is showing.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run/refreshMcpServers are stable store actions
  useEffect(() => { run(() => refreshMcpServers(spaceId)); }, [spaceId]);

  // Same idiom as EnvironmentList's checkout list: this state only ever holds the active space's data,
  // so a settings sheet opened for a non-active space would show nothing here either — an existing,
  // accepted limitation of how `sessions`/`environments` are scoped, not something this section invents.
  const agentKinds = [...new Set(Object.values(sessions).filter((s) => s.spaceId === spaceId).map((s) => s.agentKind))].sort();

  return (
    <div className="field">
      <span>MCP servers</span>
      {servers.length === 0
        ? <p className="env-empty">No MCP servers yet — add one to give this space's agents tools.</p>
        : (
          <ul className="env-list">
            {servers.map((s) => <McpServerRow key={s.id} spaceId={spaceId} server={s} />)}
          </ul>
        )}
      {adding
        ? <McpServerForm spaceId={spaceId} onDone={() => setAdding(false)} />
        : <div className="form-actions" style={{ justifyContent: "flex-start" }}>
            <button type="button" className="btn-quiet" onClick={() => setAdding(true)}>Add server…</button>
          </div>}
      {agentKinds.length > 0 && (
        <ul className="mcp-agent-notes">
          {agentKinds.map((k) => (
            <li key={k} className="muted">
              {mcpSupportNote(k)}
              {isAcpKind(k) ? " A build without http MCP support gets no tools." : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function McpServerRow({ spaceId, server }: { spaceId: string; server: McpServer }) {
  const run = useApp((s) => s.run);
  const setMcpEnabled = useApp((s) => s.setMcpEnabled);
  const removeMcpServer = useApp((s) => s.removeMcpServer);
  const retryMcpServer = useApp((s) => s.retryMcpServer);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const endpoint = server.transport === "stdio" ? [server.command, ...server.args].filter(Boolean).join(" ") : server.url;

  return (
    <li className="env-row mcp-row">
      <div className="env-main">
        <span className="status-dot" data-status={server.status} title={STATUS_LABEL[server.status]} aria-label={`Status: ${STATUS_LABEL[server.status]}`} />
        <span className="env-name">{server.name}</span>
        <span className="env-kind">{server.transport}</span>
      </div>
      <div className="env-meta">
        <code className="env-path">{endpoint || "(no endpoint set)"}</code>
      </div>
      <div className="env-actions">
        <label className="mcp-enable">
          <input type="checkbox" checked={server.enabled}
            onChange={(e) => run(() => setMcpEnabled(spaceId, server.id, e.target.checked))} />
          Enabled
        </label>
        <button type="button" className="btn-quiet" onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit"}</button>
        {confirmDelete
          ? <>
              <button type="button" className="btn-quiet" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button type="button" className="btn-quiet danger" onClick={() => run(() => removeMcpServer(server.id))}>Remove</button>
            </>
          : <button type="button" className="btn-quiet" onClick={() => setConfirmDelete(true)}>Remove…</button>}
      </div>
      {server.status === "circuit_open" && (
        <div className="mcp-circuit">
          <span>{CIRCUIT_OPEN_COPY}</span>
          <button type="button" className="btn-quiet" onClick={() => run(() => retryMcpServer(server.id))}>Retry</button>
        </div>
      )}
      {editing && <McpServerForm spaceId={spaceId} server={server} onDone={() => setEditing(false)} />}
      {server.enabled && <McpToolsPolicy spaceId={spaceId} server={server} />}
    </li>
  );
}

/** Under an enabled server: its cached tools as an allowlist, plus the one action that populates them. */
function McpToolsPolicy({ spaceId, server }: { spaceId: string; server: McpServer }) {
  const run = useApp((s) => s.run);
  const setMcpAllowedTools = useApp((s) => s.setMcpAllowedTools);
  const refreshMcpTools = useApp((s) => s.refreshMcpTools);
  const toolsError = useApp((s) => s.mcpToolsError[server.id] ?? null);

  const allowed = server.allowedTools; // null = every cached tool allowed
  const isAllowed = (name: string) => allowed === null || allowed.includes(name);

  const toggle = (name: string, checked: boolean) => {
    const universe = server.tools.map((t) => t.name);
    const next = new Set(allowed ?? universe);
    if (checked) next.add(name); else next.delete(name);
    // All-checked collapses back to null — the same "every cached tool allowed" state a server nobody
    // has narrowed already has, rather than an explicit list that happens to equal the full set.
    const explicit = universe.every((n) => next.has(n)) ? null : universe.filter((n) => next.has(n));
    run(() => setMcpAllowedTools(spaceId, server.id, explicit));
  };

  return (
    <div className="mcp-tools">
      <div className="mcp-tools-head">
        <span className="env-kind">Tools</span>
        <button type="button" className="btn-quiet" onClick={() => run(() => refreshMcpTools(server.id))}>Refresh tools</button>
      </div>
      {/* A connect failure is a RESULT (mcp.tools.list's `error`), not a thrown RPC error — and the
          text is already sanitized server-side, so it renders verbatim, never re-parsed. */}
      {toolsError && <p className="mcp-error">{toolsError}</p>}
      {server.tools.length === 0
        ? <p className="env-empty">Not connected yet — Refresh tools to connect.</p>
        : (
          <ul className="mcp-tool-list">
            {server.tools.map((t) => (
              <li key={t.name}>
                <label>
                  <input type="checkbox" checked={isAllowed(t.name)} onChange={(e) => toggle(t.name, e.target.checked)} />
                  <span className="mcp-tool-name">{t.name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

const emptyRows: SecretRow[] = [];

/** Add/edit form: the W2 fields (name, transport, endpoint, secrets) plus auth. `server` present = edit;
 *  absent = a fresh add. Self-contained on purpose — everything the form needs to reason about (dirty
 *  URL, oauth vs key, existing key names) lives in this one component. */
function McpServerForm({ spaceId, server, onDone }: { spaceId: string; server?: McpServer; onDone: () => void }) {
  const run = useApp((s) => s.run);
  const addMcpServer = useApp((s) => s.addMcpServer);
  const updateMcpServer = useApp((s) => s.updateMcpServer);

  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? "stdio");
  const [command, setCommand] = useState(server?.command ?? "");
  const [argsText, setArgsText] = useState((server?.args ?? []).join(" "));
  const [url, setUrl] = useState(server?.url ?? "");
  const [authChoice, setAuthChoice] = useState<"key" | "oauth">("key");
  const [secretRows, setSecretRows] = useState<SecretRow[]>(emptyRows);

  const isOauthRow = server?.authKind === "oauth";
  // Binding note 3: a URL or transport edit on an OAuth-connected server silently disconnects it
  // server-side — this has to be said BEFORE the user saves, not discovered after.
  const dirtyUrlOrTransport = !!server && isOauthRow && (transport !== server.transport || url !== server.url);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const secrets = Object.fromEntries(secretRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
    run(async () => {
      if (server) {
        const patch: Parameters<typeof updateMcpServer>[0] = { id: server.id, spaceId, name: trimmed, transport };
        if (transport === "stdio") { patch.command = command.trim(); patch.args = argsText.split(/\s+/).filter(Boolean); }
        else { patch.url = url.trim(); }
        // Omitted entirely when untouched: mcp.update keeps whatever secrets are already stored.
        if (secretRows.length > 0) { if (transport === "stdio") patch.env = secrets; else patch.headers = secrets; }
        await updateMcpServer(patch);
      } else {
        const patch: Parameters<typeof addMcpServer>[0] = { spaceId, name: trimmed, transport };
        if (transport === "stdio") { patch.command = command.trim(); patch.args = argsText.split(/\s+/).filter(Boolean); patch.env = secrets; }
        else { patch.url = url.trim(); if (authChoice === "key") patch.headers = secrets; }
        await addMcpServer(patch);
      }
      onDone();
    });
  };

  return (
    <form className="form mcp-form" onSubmit={submit}>
      <label className="field"><span>Name</span>
        <input aria-label="Server name" value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="field"><span>Transport</span>
        <select aria-label="Transport" value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)}>
          <option value="stdio">stdio</option>
          <option value="http">http</option>
          <option value="sse">sse</option>
        </select>
      </label>
      {transport === "stdio"
        ? <>
            <label className="field"><span>Command</span>
              <input aria-label="Command" value={command} onChange={(e) => setCommand(e.target.value)} />
            </label>
            <label className="field"><span>Arguments</span>
              <input aria-label="Arguments" value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="space-separated" />
            </label>
            <SecretsFields label="Environment variables" existingKeys={server?.envKeys ?? []} rows={secretRows} setRows={setSecretRows} />
          </>
        : <>
            <label className="field"><span>URL</span>
              <input aria-label="Server URL" value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            {dirtyUrlOrTransport && (
              <p className="mcp-warning">Changing the URL or transport disconnects this server's OAuth connection — you will need to reconnect.</p>
            )}
            {!server && (
              <div className="field"><span>Authentication</span>
                <div className="mcp-auth-choice" role="radiogroup" aria-label="Authentication">
                  <label><input type="radio" name="mcp-auth" checked={authChoice === "key"} onChange={() => setAuthChoice("key")} /> API key headers</label>
                  <label><input type="radio" name="mcp-auth" checked={authChoice === "oauth"} onChange={() => setAuthChoice("oauth")} /> OAuth</label>
                </div>
              </div>
            )}
            {(server ? !isOauthRow : authChoice === "key") && (
              <SecretsFields label="Headers" existingKeys={server?.headerKeys ?? []} rows={secretRows} setRows={setSecretRows} />
            )}
            {!server && authChoice === "oauth" && (
              <p className="muted">Save this server, then use Connect in its row to authorize.</p>
            )}
            {server && <McpOauthControls server={server} />}
          </>}
      <div className="form-actions">
        <button type="button" className="btn-quiet" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn primary">{server ? "Save" : "Add server"}</button>
      </div>
    </form>
  );
}

/**
 * Binding note 4: `MCP_SECRET_STORAGE_NOTE` has to be visible wherever a secret is entered — this is
 * that surface, always rendered whenever the field itself is on screen, whether or not any row is
 * filled in yet.
 *
 * Existing key NAMES are shown for context, but their values never come back from the server (they are
 * write-only), so this can only ever be a "set/replace" affordance: `mcp.update`/`mcp.add` replace the
 * whole map, and this component has no way to resend a value it was never given. Touching this section
 * at all means re-entering every key the user wants to keep — the hint says so.
 */
function SecretsFields({ label, existingKeys, rows, setRows }: { label: string; existingKeys: string[]; rows: SecretRow[]; setRows: (r: SecretRow[]) => void }) {
  const addRow = () => setRows([...rows, { key: "", value: "" }]);
  const updateRow = (i: number, patch: Partial<SecretRow>) => setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number) => setRows(rows.filter((_, idx) => idx !== i));
  return (
    <div className="field mcp-secrets">
      <span>{label}</span>
      {existingKeys.length > 0 && (
        <p className="mcp-secret-hint">
          Currently set: {existingKeys.join(", ")}. Adding a key here replaces the whole set for this server — anything not listed below is removed.
        </p>
      )}
      {rows.map((row, i) => (
        <div className="mcp-secret-row" key={i}>
          <input aria-label={`${label} key`} value={row.key} onChange={(e) => updateRow(i, { key: e.target.value })} placeholder="KEY" />
          <input aria-label={`${label} value`} type="password" value={row.value} onChange={(e) => updateRow(i, { value: e.target.value })} placeholder="value" />
          <button type="button" className="btn-quiet" aria-label={`Remove ${label} row ${i + 1}`} onClick={() => removeRow(i)}>×</button>
        </div>
      ))}
      <div className="form-actions" style={{ justifyContent: "flex-start" }}>
        <button type="button" className="btn-quiet" onClick={addRow}>+ Add key</button>
      </div>
      <p className="mcp-secret-note">{MCP_SECRET_STORAGE_NOTE}</p>
    </div>
  );
}

/**
 * Binding note 2: `authKind` and `oauthStatus` answer different questions. `authKind !== "oauth"` offers
 * OAuth as something to switch TO (the key form stays visible beside it — see the caller). Once
 * `authKind === "oauth"`, this is the ONLY auth control rendered for the row (the caller never shows the
 * key form alongside it) — `reconnect_needed` renders "Reconnect" with a warning, never the key form.
 */
function McpOauthControls({ server }: { server: McpServer }) {
  const run = useApp((s) => s.run);
  const startMcpOauth = useApp((s) => s.startMcpOauth);
  const disconnectMcpOauth = useApp((s) => s.disconnectMcpOauth);

  const connect = () => run(async () => {
    const { authUrl } = await startMcpOauth(server.id);
    // The renderer opens it; main's window-open handler routes http(s) to the system browser
    // (apps/desktop/src/main/index.ts's setWindowOpenHandler) rather than navigating the app itself.
    window.open(authUrl, "_blank");
  });

  if (server.authKind !== "oauth") {
    return (
      <div className="field"><span>OAuth</span>
        <div className="form-actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="btn-quiet" onClick={connect}>Connect via OAuth instead</button>
        </div>
      </div>
    );
  }
  if (server.oauthStatus === "reconnect_needed") {
    return (
      <div className="field"><span>OAuth</span>
        <p className="mcp-warning">This connection needs to be reauthorized before this server will work again.</p>
        <div className="form-actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="btn-quiet" onClick={connect}>Reconnect</button>
        </div>
      </div>
    );
  }
  if (server.oauthStatus === "connected") {
    return (
      <div className="field"><span>OAuth</span>
        <p className="muted">Connected.</p>
        <div className="form-actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="btn-quiet" onClick={() => run(() => disconnectMcpOauth(server.id))}>Disconnect</button>
        </div>
      </div>
    );
  }
  // authKind is "oauth" (a flow was started) but oauthStatus is still "unconfigured" — abandoned browser tab.
  return (
    <div className="field"><span>OAuth</span>
      <div className="form-actions" style={{ justifyContent: "flex-start" }}>
        <button type="button" className="btn-quiet" onClick={connect}>Connect</button>
      </div>
    </div>
  );
}
