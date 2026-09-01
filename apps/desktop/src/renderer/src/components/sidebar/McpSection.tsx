import { MCP_SECRET_STORAGE_NOTE, McpServerNameSchema, mcpSupportNote, type AgentKind, type McpServer, type McpServerStatus, type McpTransport } from "@realm/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { useApp, type McpTestResult } from "../../state/store";
import { MoveScopeConfirm, ScopeGroups } from "../scoped/ScopeGroups";

/** The hub's PUSHED state, worded honestly: `idle` means the hub has never dialed this server — it
 *  says nothing about health, so the dot must not imply any was checked (W4's "not checked" rule). */
const STATUS_LABEL: Record<McpServerStatus, string> = {
  idle: "Not checked yet", connected: "Connected", error: "Error", circuit_open: "Circuit open",
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
 * MCP servers, auth and per-space/per-tool policy — the **Connections** tab of the space page (born
 * in Plan 8 W5's settings sheet, promoted with it in Plan 12 W3), following the sibling panels'
 * idiom (`useApp`, `run()`, a `form settings-panel` root wrapping `.field` sections).
 *
 * Every state here has to say something, per the plan's honesty rule: a server with no cached tools
 * names the action that would get it some; a blocked circuit names its own fix; a secret field never
 * lets the user forget where the value is going.
 */
export function McpSection({ spaceId }: { spaceId: string }) {
  const servers = useApp((s) => s.mcpServers);
  const sessions = useApp((s) => s.sessions);
  const refreshMcpServers = useApp((s) => s.refreshMcpServers);
  const clearMcpServers = useApp((s) => s.clearMcpServers);
  const openActivity = useApp((s) => s.openActivity);
  const run = useApp((s) => s.run);
  const [adding, setAdding] = useState(false);

  // Fetch on mount — since Plan 12 W3 that means the space page's Connections tab being shown.
  // Clearing first is deliberate — without it, opening Connections for a different space would flash
  // the PREVIOUS space's server rows (and a stale tools error that belongs to a server not even shown
  // here) until the fetch lands. `clearMcpServers(spaceId)` also records which space's panel is
  // mounted (the store's guard against slow responses and `mcp.changed` refetches landing elsewhere);
  // the cleanup un-records it.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run/refreshMcpServers/clearMcpServers are stable store actions
  useEffect(() => {
    clearMcpServers(spaceId); run(() => refreshMcpServers(spaceId));
    return () => clearMcpServers(null);
  }, [spaceId]);

  // Same idiom as EnvironmentList's checkout list: this state only ever holds the active space's data,
  // so a Connections tab shown for a non-active space would show nothing here either — an existing,
  // accepted limitation of how `sessions`/`environments` are scoped, not something this section invents.
  const agentKinds = [...new Set(Object.values(sessions).filter((s) => s.spaceId === spaceId).map((s) => s.agentKind))].sort();

  return (
    <div className="form settings-panel">
      <div className="field">
        <div className="mcp-section-head">
          <span>MCP servers</span>
          {/* Activity is still a sheet; it opens OVER the page (one sheet slot, ruling 4). */}
          <button type="button" className="btn-quiet" onClick={() => run(() => openActivity())}>Activity</button>
        </div>
        {servers.length === 0
          ? <p className="env-empty">No MCP servers yet — add one to give this space's agents tools.</p>
          : (
            // W4: the shared scope grouping — the same "This space" / "From <profile>" / "Everywhere"
            // sections the Library renders, over the same rows this list always held.
            <ScopeGroups listClassName="env-list"
              entries={servers.map((s) => ({ key: s.id, scope: s.scope, row: <McpServerRow key={s.id} spaceId={spaceId} server={s} /> }))} />
          )}
        {adding
          ? <McpServerForm spaceId={spaceId} onDone={() => setAdding(false)} />
          : <div className="form-actions" style={{ justifyContent: "flex-start" }}>
              <button type="button" className="btn-quiet" onClick={() => setAdding(true)}>Add server…</button>
            </div>}
        <RealmProviders spaceId={spaceId} />
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
        {/* W5's rule, kept over ours: the storage disclosure is a property of the servers this tab
            already lists, not only of a form that happens to be open — so it is on screen whenever the
            tab is, and the copy at each secret field (SecretsFields) is in addition to it, not instead. */}
        <p className="settings-note">{MCP_SECRET_STORAGE_NOTE}</p>
      </div>
    </div>
  );
}

/**
 * Realm-native gateway toolsets (`realm-browser`, `realm-agent`), rendered as rows like the servers
 * above but honestly different: no status dot (they are in-process — there is no connection to have
 * checked), no editor, no scope moves (they are code, not config — the same in every profile), just
 * this space's switch. Default ON, per `mcp.setProviderEnabled`'s rationale.
 */
function RealmProviders({ spaceId }: { spaceId: string }) {
  const providers = useApp((s) => s.mcpProviders);
  const setMcpProviderEnabled = useApp((s) => s.setMcpProviderEnabled);
  const run = useApp((s) => s.run);
  if (providers.length === 0) return null;
  return (
    <div className="field">
      <span>Realm's own tools</span>
      <p className="settings-hint">Built into Realm and served through the same gateway. On by default — they run under Realm's own permission flow, not as a process you configured. The switch is this space's.</p>
      <ul className="env-list">
        {providers.map((p) => (
          <li key={p.name} className="env-row mcp-row">
            <div className="env-main">
              <span className="env-name">{p.name}</span>
              <span className="env-kind">built-in</span>
            </div>
            <div className="env-actions">
              <label className="mcp-enable">
                <input type="checkbox" aria-label={`Provider ${p.name} in this space`} checked={p.enabled}
                  onChange={(e) => run(() => setMcpProviderEnabled(spaceId, p.name, e.target.checked))} />
                Enabled
              </label>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function McpServerRow({ spaceId, server }: { spaceId: string; server: McpServer }) {
  const run = useApp((s) => s.run);
  const setMcpEnabled = useApp((s) => s.setMcpEnabled);
  const removeMcpServer = useApp((s) => s.removeMcpServer);
  const retryMcpServer = useApp((s) => s.retryMcpServer);
  const testMcpServer = useApp((s) => s.testMcpServer);
  const promoteMcpServer = useApp((s) => s.promoteMcpServer);
  const demoteMcpServer = useApp((s) => s.demoteMcpServer);
  const profiles = useApp((s) => s.profiles);
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmMove, setConfirmMove] = useState(false);
  const [test, setTest] = useState<McpTestResult | "testing" | null>(null);

  const endpoint = server.transport === "stdio" ? [server.command, ...server.args].filter(Boolean).join(" ") : server.url;
  // Inherited = defined at the profile (§2's contract): toggleable here (the per-space override — the
  // same setEnabled wire, routed server-side), never editable in place. The editor still opens, but as
  // "Edit in profile": the SAME McpServerForm, wearing a banner that names the defining scope — mcp.update
  // edits the one row every profile space shares, and the user must know that before saving.
  const inherited = server.scope.kind === "profile";
  const profileId = server.scope.kind === "profile" ? server.scope.profileId : space?.profileId;
  const profileName = profiles.find((p) => p.id === profileId)?.name ?? "profile";

  // W5's live check, kept through the merge: the status dot is the HUB's steady-state opinion, which
  // says nothing useful right after an edit (still `idle`) or once a breaker has tripped. Test dials
  // the upstream server directly and answers "is what I just typed reachable at all". Local state, not
  // the store — a probe result belongs to the row the user clicked, and is stale the moment they edit.
  const runTest = () => {
    setTest("testing");
    run(async () => {
      try { setTest(await testMcpServer(server.id)); }
      catch (e) { setTest({ reached: false, detail: e instanceof Error ? e.message : String(e) }); throw e; }
    });
  };

  return (
    <li className="env-row mcp-row">
      <div className="env-main">
        <span className="status-dot" data-status={server.status} title={STATUS_LABEL[server.status]} aria-label={`Status: ${STATUS_LABEL[server.status]}`} />
        <span className="env-name">{server.name}</span>
        <span className="env-kind">{server.transport}</span>
        {/* The hub status dot only says whether calls currently succeed — it says nothing about auth,
            so a server needing reauth otherwise looks completely normal until Edit is opened. */}
        {server.authKind === "oauth" && server.oauthStatus === "reconnect_needed" && (
          <span className="mcp-reauth-badge">Needs reauth</span>
        )}
      </div>
      <div className="env-meta">
        <code className="env-path">{endpoint || "(no endpoint set)"}</code>
        {/* `detail` is built server-side from things that cannot be secrets (see live-check.ts), so it
            renders verbatim — same rule as the tools error below. */}
        {test && <span className="mcp-test" data-reached={test !== "testing" && test.reached ? "true" : undefined}>
          {test === "testing" ? "Testing…" : test.detail}
        </span>}
      </div>
      <div className="env-actions">
        <label className="mcp-enable">
          {/* Always the per-space wire, whatever the scope: for an inherited server the server side
              flips this space's override, never the defining scope's state (the named W4 mutant). */}
          <input type="checkbox" checked={server.enabled}
            title={inherited ? `Defined in ${profileName} — this switch is this space's override.` : undefined}
            onChange={(e) => run(() => setMcpEnabled(spaceId, server.id, e.target.checked))} />
          Enabled
        </label>
        <button type="button" className="btn-quiet" onClick={runTest}>Test</button>
        {/* Never a bare "Edit" on an inherited row — in-place editing is the mutant §2 forbids. The
            affordance jumps to the defining scope's editor: the same form, opened AS the profile's. */}
        <button type="button" className="btn-quiet" onClick={() => setEditing((v) => !v)}>
          {editing ? "Close" : inherited ? "Edit in profile" : "Edit"}
        </button>
        {!confirmMove && (
          <button type="button" className="btn-quiet" onClick={() => setConfirmMove(true)}>
            {inherited ? "Move to this space…" : "Move to profile…"}
          </button>
        )}
        {confirmDelete
          ? <>
              {/* Removal always acts at the defining scope; for an inherited row that reach is named. */}
              {inherited && <span className="muted">Removes it for every space of {profileName}.</span>}
              <button type="button" className="btn-quiet" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button type="button" className="btn-quiet danger" onClick={() => run(() => removeMcpServer(server.id))}>Remove</button>
            </>
          : <button type="button" className="btn-quiet" onClick={() => setConfirmDelete(true)}>Remove…</button>}
      </div>
      {confirmMove && (
        <MoveScopeConfirm direction={inherited ? "demote" : "promote"} name={server.name} profileName={profileName}
          onCancel={() => setConfirmMove(false)}
          onConfirm={() => { setConfirmMove(false); run(() => (inherited ? demoteMcpServer : promoteMcpServer)(spaceId, server.id)); }} />
      )}
      {server.status === "circuit_open" && (
        <div className="mcp-circuit">
          <span>{CIRCUIT_OPEN_COPY}</span>
          <button type="button" className="btn-quiet" onClick={() => run(() => retryMcpServer(server.id))}>Retry</button>
        </div>
      )}
      {editing && <McpServerForm spaceId={spaceId} server={server} onDone={() => setEditing(false)}
        scopeNote={inherited ? `Defined in ${profileName}. Changes here apply to every space of ${profileName}.` : undefined} />}
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
function McpServerForm({ spaceId, server, onDone, scopeNote }: { spaceId: string; server?: McpServer; onDone: () => void;
  /** Set when this form is the DEFINING scope's editor opened from an inheriting space ("Edit in
   *  profile"): one sentence naming the scope and the reach of a save. Rendered first — the user must
   *  read it before any field. */
  scopeNote?: string }) {
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
  // server-side — this has to be said BEFORE the user saves, not discovered after. Trimmed so the
  // comparison matches what actually gets sent on submit (untrimmed whitespace must not read as clean).
  const dirtyUrlOrTransport = !!server && isOauthRow && (transport !== server.transport || url.trim() !== server.url);

  // W5's check, kept: the name is what every agent keys the server by on the wire (a TOML bare key for
  // Codex), so a name the wire would reject has to be refused HERE — the RPC would reject it anyway,
  // but as a red error banner that never names the field that caused it.
  const nameOk = McpServerNameSchema.safeParse(name.trim()).success;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!nameOk) return;
    const secrets = Object.fromEntries(secretRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
    run(async () => {
      if (server) {
        const patch: Parameters<typeof updateMcpServer>[0] = { id: server.id, spaceId, name: trimmed, transport };
        if (transport === "stdio") { patch.command = command.trim(); patch.args = argsText.split(/\s+/).filter(Boolean); }
        else { patch.url = url.trim(); }
        // Omitted entirely unless at least one row actually named a key: mcp.update REPLACES the whole
        // map, and `secrets` built from rows that are all blank is `{}` — sending that would wipe every
        // stored key. Gating on the built object (not `secretRows.length`) is what keeps a stray
        // "+ Add key" click with nothing typed from being a silent delete-everything.
        if (Object.keys(secrets).length > 0) { if (transport === "stdio") patch.env = secrets; else patch.headers = secrets; }
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
      {scopeNote && <p className="settings-note scope-note">{scopeNote}</p>}
      <label className="field"><span>Name</span>
        <input aria-label="Server name" value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      {name.trim().length > 0 && !nameOk && <p className="mcp-error">Letters, digits, underscore or hyphen only.</p>}
      <label className="field"><span>Transport</span>
        <select aria-label="Transport" value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)}>
          <option value="stdio">stdio</option>
          <option value="http">http</option>
          <option value="sse">sse</option>
        </select>
      </label>
      {/* Hoisted ABOVE the transport branch (spec review defect 1): an oauth row's warning and its
          Connect/Disconnect/Reconnect controls describe the STORED row, not whatever transport happens
          to be selected in this pending edit — so they must survive the user flipping the Transport
          select to stdio, not disappear along with the (rightly hidden) headers form. */}
      {server && isOauthRow && (
        <>
          {dirtyUrlOrTransport && (
            <p className="mcp-warning">Changing the URL or transport disconnects this server's OAuth connection — you will need to reconnect.</p>
          )}
          <McpOauthControls server={server} />
        </>
      )}
      {transport === "stdio"
        ? <>
            <label className="field"><span>Command</span>
              <input aria-label="Command" value={command} onChange={(e) => setCommand(e.target.value)} />
            </label>
            <label className="field"><span>Arguments</span>
              <input aria-label="Arguments" value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="space-separated" />
            </label>
            {/* Never the forbidden cell: an oauth row switched (even mid-edit, unsaved) to stdio must
                not suddenly offer an env-var key form for a server that authenticates via OAuth. */}
            {!isOauthRow && (
              <SecretsFields label="Environment variables" existingKeys={server?.envKeys ?? []} rows={secretRows} setRows={setSecretRows} />
            )}
          </>
        : <>
            <label className="field"><span>URL</span>
              <input aria-label="Server URL" value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
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
              <p className="muted">Save this server, then open Edit to Connect and authorize.</p>
            )}
            {/* The offer to switch TO oauth — only for an existing, not-yet-oauth remote server. An
                oauth row's own controls are the hoisted block above, shown regardless of transport. */}
            {server && !isOauthRow && <McpOauthControls server={server} />}
          </>}
      <div className="form-actions">
        <button type="button" className="btn-quiet" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn primary" disabled={!nameOk}>{server ? "Save" : "Add server"}</button>
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
          Currently set: {existingKeys.join(", ")}. Typing at least one key below replaces the whole set
          for this server — anything not listed is removed. Leaving every row blank (or adding none)
          keeps the current keys exactly as they are.
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
