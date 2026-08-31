import { AGENT_META, McpServerNameSchema, SELECTABLE_AGENT_KINDS, mcpSupportNote, type McpServer, type McpTransport } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import { useApp, type McpTestResult } from "../../state/store";

/**
 * The connections tab of the space-settings sheet (W5): Realm's MCP servers with THIS space's opt-ins.
 *
 * Definitions are global; the enable set is per-space and OPT-IN (W2's inversion of the skills
 * default): a server added while configuring one space must not arm itself in another. The panel says
 * so, because a toggle whose scope is invisible is how the named leak happens.
 *
 * Secrets: values are typed into the form, sent, and gone. `mcp.list` has no field for them, so
 * nothing this panel renders after a save CAN contain one — the edit form shows key names with a
 * replace affordance only.
 */
export function McpPanel({ spaceId }: { spaceId: string }) {
  const mcp = useApp((s) => s.spaceMcp[spaceId]);
  const refreshMcp = useApp((s) => s.refreshMcp);
  const setMcpEnabled = useApp((s) => s.setMcpEnabled);
  const removeMcpServer = useApp((s) => s.removeMcpServer);
  const testMcpServer = useApp((s) => s.testMcpServer);
  const run = useApp((s) => s.run);
  const [view, setView] = useState<"list" | "add" | { editId: string }>("list");
  const [tests, setTests] = useState<Record<string, McpTestResult | "testing">>({});
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  useEffect(() => { run(() => refreshMcp(spaceId)); }, [spaceId, refreshMcp, run]);

  const test = (id: string) => {
    setTests((t) => ({ ...t, [id]: "testing" }));
    run(async () => {
      try { const r = await testMcpServer(id); setTests((t) => ({ ...t, [id]: r })); }
      catch (e) { setTests((t) => ({ ...t, [id]: { reached: false, detail: e instanceof Error ? e.message : String(e) } })); throw e; }
    });
  };

  if (!mcp) return <div className="form settings-panel"><p className="env-empty">Loading…</p></div>;

  if (view !== "list") {
    const existing = view === "add" ? null : mcp.servers.find((s) => s.id === view.editId) ?? null;
    return <McpServerForm spaceId={spaceId} existing={existing} secretNote={mcp.secretNote} onDone={() => setView("list")} />;
  }

  return (
    <div className="form settings-panel">
      <div className="field">
        <span>MCP servers in this space</span>
        {mcp.servers.length === 0
          ? <p className="env-empty">No servers yet. Add one to give this space's sessions extra tools.</p>
          : (
            <ul className="settings-list">
              {mcp.servers.map((s) => {
                const keys = s.transport === "stdio" ? s.envKeys : s.headerKeys;
                const t = tests[s.id];
                return (
                  <li key={s.id} className="settings-row">
                    <div className="settings-row-main">
                      <span className="settings-row-name">{s.name}</span>
                      <span className="settings-chip">{s.transport}</span>
                      <code className="env-path">{s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url}</code>
                      {keys.length > 0 && (
                        <span className="settings-hint">{s.transport === "stdio" ? "env" : "headers"}: {keys.join(", ")} — set</span>
                      )}
                      {t && (
                        <span className="settings-test" data-tone={t === "testing" ? "muted" : t.reached ? "ready" : "warning"}>
                          {t === "testing" ? "Testing…" : t.detail}
                        </span>
                      )}
                      {confirmRemove === s.id ? (
                        <span className="settings-confirm">
                          <span className="muted">Remove “{s.name}” from every space, keys included?</span>
                          <button type="button" className="btn" onClick={() => setConfirmRemove(null)}>Cancel</button>
                          <button type="button" className="btn danger" onClick={() => { setConfirmRemove(null); run(() => removeMcpServer(spaceId, s.id)); }}>Remove</button>
                        </span>
                      ) : (
                        <span className="settings-row-actions">
                          <button type="button" className="btn-quiet" onClick={() => test(s.id)}>Test</button>
                          <button type="button" className="btn-quiet" onClick={() => setView({ editId: s.id })}>Edit</button>
                          <button type="button" className="btn-quiet" onClick={() => setConfirmRemove(s.id)}>Remove…</button>
                        </span>
                      )}
                    </div>
                    <input type="checkbox" role="switch" className="switch" aria-label={`Server ${s.name} in this space`}
                      checked={s.enabled} onChange={(e) => run(() => setMcpEnabled(spaceId, s.id, e.target.checked))} />
                  </li>
                );
              })}
            </ul>
          )}
        <p className="settings-hint">Servers are defined once and shared; each space opts in on its own — new servers start off everywhere except the space they were added from.</p>
        <div className="form-actions settings-add"><button type="button" className="btn" onClick={() => setView("add")}>Add server…</button></div>
      </div>
      <div className="field">
        <span>What each agent connects to</span>
        <ul className="settings-list">
          {SELECTABLE_AGENT_KINDS.map((kind) => (
            <li key={kind} className="settings-agent-row">
              <Icon name={AGENT_META[kind].icon} size={14} colored />
              <span className="settings-agent-note">{mcpSupportNote(kind)}</span>
            </li>
          ))}
        </ul>
      </div>
      {/* W2 returns this on every list precisely so this panel cannot forget it. */}
      <p className="settings-note">{mcp.secretNote}</p>
    </div>
  );
}

type SecretRow = { key: string; value: string };

/**
 * Add/edit one server. Secret values exist only in this form's local state, on the way IN — the wire
 * never returns them, so editing shows key names with "set" and a Replace affordance. Replacing is
 * whole-map by design (`mcp.update` semantics); the form says so rather than pretending a single key
 * can be kept without re-entering it.
 */
function McpServerForm({ spaceId, existing, secretNote, onDone }: { spaceId: string; existing: McpServer | null; secretNote: string; onDone: () => void }) {
  const addMcpServer = useApp((s) => s.addMcpServer);
  const updateMcpServer = useApp((s) => s.updateMcpServer);
  const run = useApp((s) => s.run);
  const [name, setName] = useState(existing?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(existing?.transport ?? "stdio");
  const [command, setCommand] = useState(existing?.command ?? "");
  const [argsText, setArgsText] = useState(existing?.args.join(" ") ?? "");
  const [url, setUrl] = useState(existing?.url ?? "");
  const existingKeys = existing ? (existing.transport === "stdio" ? existing.envKeys : existing.headerKeys) : [];
  // Adding always sends the map; editing sends it only once the user chose to replace it, so a rename
  // never wipes keys the form was never shown.
  const [replacing, setReplacing] = useState(existing === null);
  const [rows, setRows] = useState<SecretRow[]>(existing === null ? [{ key: "", value: "" }] : []);

  const secretLabel = transport === "stdio" ? "Environment variables" : "Headers";
  const nameOk = McpServerNameSchema.safeParse(name).success;
  const endpointOk = transport === "stdio" ? command.trim().length > 0 : url.trim().length > 0;
  // A transport switch drops the stored secrets server-side (nothing carries across), so the form must
  // collect fresh ones rather than show "set" chips that will not survive the save.
  const transportChanged = existing !== null && transport !== existing.transport;
  const mustReplace = replacing || transportChanged;

  const setRow = (i: number, patch: Partial<SecretRow>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  const save = () => {
    const secrets = Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
    const endpoint = transport === "stdio"
      ? { command: command.trim(), args: argsText.trim() ? argsText.trim().split(/\s+/) : [], ...(mustReplace ? { env: secrets } : {}) }
      : { url: url.trim(), ...(mustReplace ? { headers: secrets } : {}) };
    run(async () => {
      if (existing) await updateMcpServer({ id: existing.id, spaceId, name: name.trim(), transport, ...endpoint });
      else await addMcpServer({ spaceId, name: name.trim(), transport, ...endpoint });
    });
    onDone();
  };

  return (
    <form className="form settings-panel" onSubmit={(e) => { e.preventDefault(); if (nameOk && endpointOk) save(); }}>
      <label className="field"><span>Name</span>
        <input aria-label="Server name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. vercel" spellCheck={false} />
      </label>
      {!nameOk && name.length > 0 && <p className="settings-problem">Letters, digits, underscore or hyphen only.</p>}
      <fieldset className="field">
        <legend>Transport</legend>
        <div className="settings-transport" role="presentation">
          {(["stdio", "http", "sse"] as const).map((t) => (
            <label key={t} className="settings-transport-choice" data-selected={transport === t || undefined}>
              <input type="radio" name="mcp-transport" value={t} checked={transport === t} onChange={() => setTransport(t)} />
              {t}
            </label>
          ))}
        </div>
      </fieldset>
      {transport === "stdio" ? (
        <>
          <label className="field"><span>Command</span>
            <input aria-label="Command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="e.g. npx" spellCheck={false} />
          </label>
          <label className="field"><span>Arguments (space-separated)</span>
            <input aria-label="Arguments" value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="e.g. -y @modelcontextprotocol/server-github" spellCheck={false} />
          </label>
        </>
      ) : (
        <label className="field"><span>URL</span>
          <input aria-label="Server URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com" spellCheck={false} />
        </label>
      )}
      <div className="field">
        <span>{secretLabel}</span>
        {!mustReplace ? (
          existingKeys.length === 0
            ? <p className="env-empty">None set. <button type="button" className="btn-quiet" onClick={() => { setReplacing(true); setRows([{ key: "", value: "" }]); }}>Add keys…</button></p>
            : (
              <div className="settings-keys">
                {existingKeys.map((k) => <span key={k} className="settings-chip" data-set>{k} · set</span>)}
                <button type="button" className="btn-quiet" onClick={() => { setReplacing(true); setRows(existingKeys.map((k) => ({ key: k, value: "" }))); }}>Replace keys…</button>
              </div>
            )
        ) : (
          <>
            {existing !== null && (
              <p className="settings-hint">Saving replaces every key and value. Stored values are never shown back, so re-enter the value of any key you keep.</p>
            )}
            {rows.map((r, i) => (
              <div key={i} className="settings-secret-row">
                <input aria-label={`Key ${i + 1}`} value={r.key} onChange={(e) => setRow(i, { key: e.target.value })} placeholder="KEY" spellCheck={false} />
                {/* type=password keeps a typed value off screenshots; it still travels in the clear — the note below owns that. */}
                <input aria-label={`Value for ${r.key || `key ${i + 1}`}`} type="password" autoComplete="off" value={r.value}
                  onChange={(e) => setRow(i, { value: e.target.value })} placeholder="value" />
                <button type="button" className="icon-btn" aria-label={`Remove ${r.key || `key ${i + 1}`}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <div><button type="button" className="btn-quiet" onClick={() => setRows((rs) => [...rs, { key: "", value: "" }])}>Add key</button></div>
          </>
        )}
      </div>
      <p className="settings-note">{secretNote}</p>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn primary" disabled={!nameOk || !endpointOk}>{existing ? "Save server" : "Add server"}</button>
      </div>
    </form>
  );
}
