import { AGENT_META, AGENT_MODELS, PERMISSION_MODES, type AgentKind } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import { useApp } from "../../state/store";
import { Sheet } from "../../components/Sheet";

/** Pick an agent (from the probe), a working directory (space folder or a project), a model and a permission mode. */
export function NewSessionSheet() {
  const probe = useApp((s) => s.agentProbe);
  const projects = useApp((s) => s.projects);
  const space = useApp((s) => s.activeSpace());
  const probeAgents = useApp((s) => s.probeAgents);
  const newSession = useApp((s) => s.newSession);
  const closeSheet = useApp((s) => s.closeSheet);
  const run = useApp((s) => s.run);
  const [agent, setAgent] = useState<AgentKind | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [permissionMode, setPermissionMode] = useState<string>("default");
  const [probing, setProbing] = useState(true);
  const [probeError, setProbeError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    run(() => probeAgents()
      .catch((e: unknown) => { if (alive) setProbeError(e instanceof Error ? e.message : String(e)); throw e; })
      .finally(() => { if (alive) setProbing(false); }));
    return () => { alive = false; };
  }, [probeAgents, run]);
  useEffect(() => { if (!agent) { const first = probe.find((p) => p.available); if (first) setAgent(first.kind); } }, [probe, agent]);

  const models = agent ? (AGENT_MODELS[agent] as ReadonlyArray<{ id: string; label: string }>) : [];
  const chosen = probe.find((p) => p.kind === agent);
  const canCreate = !!agent && !!chosen?.available;
  const submit = () => {
    if (!agent || !canCreate) return;
    run(() => newSession({ agentKind: agent, projectId: projectId || null, model: model || null, permissionMode }));
    closeSheet();
  };
  return (
    <Sheet title="New session" onClose={closeSheet} width={400}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field"><span>Agent</span>
          <div className="agent-list" role="radiogroup" aria-label="Agent">
            {probing && probe.length === 0 && <div className="muted">Checking installed agents…</div>}
            {probeError && <div className="agent-error" role="alert">Couldn't check agents: {probeError}</div>}
            {probe.some((p) => p.kind === "claude") && <div className="agent-hint-text muted">Claude uses your <code>claude</code> login — run <code>claude auth login</code> if sessions fail to authenticate.</div>}
            {!probing && !probeError && probe.length === 0 && <div className="muted">No agents available.</div>}
            {probe.map((p) => (
              <button type="button" key={p.kind} role="radio" aria-checked={agent === p.kind} className="agent-choice" data-selected={agent === p.kind || undefined}
                disabled={!p.available} title={p.reason ?? undefined} onClick={() => { setAgent(p.kind); setModel(""); }}>
                <Icon name={AGENT_META[p.kind].icon} size={16} />
                <span className="agent-name">{AGENT_META[p.kind].label}</span>
                <span className="agent-hint muted">{p.available ? (p.version ?? "") : (p.reason ?? "unavailable")}</span>
              </button>
            ))}
          </div>
        </div>
        <label className="field"><span>Working directory</span>
          <select aria-label="Working directory" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{space ? `Space folder (${space.folderPath.split("/").pop()})` : "Space folder"}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.rootPath}</option>)}
          </select>
        </label>
        {models.length > 0 && (
          <label className="field"><span>Model</span>
            <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Default</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
        )}
        <label className="field"><span>Permissions</span>
          <select aria-label="Permission mode" value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
            {PERMISSION_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <div className="form-actions">
          <button type="button" className="btn" onClick={closeSheet}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!canCreate}>Create</button>
        </div>
      </form>
    </Sheet>
  );
}
