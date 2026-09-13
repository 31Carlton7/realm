import { useMemo, useState } from "react";
import type { CodexSetupBinding, CodexSetupScan } from "@realm/contracts";
import { useApp } from "../../state/store";

export function CodexSetupPanel() {
  const profiles = useApp((s) => s.profiles);
  const spaces = useApp((s) => s.spaces);
  const scanSetup = useApp((s) => s.codexSetupScan);
  const applySetup = useApp((s) => s.codexSetupApply);
  const rollbackSetup = useApp((s) => s.codexSetupRollback);
  const run = useApp((s) => s.run);
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
  const [rootsText, setRootsText] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [policy, setPolicy] = useState("inherit");
  const [scan, setScan] = useState<CodexSetupScan | null>(null);
  const [binding, setBinding] = useState<CodexSetupBinding | null>(null);
  const [busy, setBusy] = useState<"scan" | "apply" | "rollback" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const cwd = spaces.find((space) => space.profileId === profileId)?.folderPath ?? "";
  const roots = useMemo(() => rootsText.split("\n").map((path) => path.trim()).filter(Boolean), [rootsText]);
  const overrides = useMemo<CodexSetupBinding["overrides"]>(() => ({
    ...(model.trim() ? { model: model.trim() } : {}), ...(provider.trim() ? { provider: provider.trim() } : {}), ...(reasoning ? { reasoning } : {}),
    ...(policy === "workspace" ? { approvalPolicy: "on-request", sandbox: "workspace-write" } : policy === "full" ? { approvalPolicy: "never", sandbox: "danger-full-access" } : policy === "readonly" ? { approvalPolicy: "never", sandbox: "read-only" } : {}),
  }), [model, provider, reasoning, policy]);

  const preview = async () => {
    if (!cwd) return;
    setBusy("scan"); setMessage(null);
    try { setScan(await scanSetup({ cwd, extraSkillRoots: roots })); }
    catch { setMessage("Codex setup could not be inspected."); }
    finally { setBusy(null); }
  };
  const connect = async () => {
    if (!scan || !profileId) return;
    setBusy("apply"); setMessage(null);
    try { setBinding(await applySetup({ profileId, scan: { cwd: scan.cwd, extraSkillRoots: roots, fingerprint: scan.fingerprint }, overrides })); setMessage("Codex setup connected."); }
    catch { setMessage("Setup changed after preview. Scan again before connecting."); }
    finally { setBusy(null); }
  };
  const disconnect = async () => {
    if (!binding) return;
    setBusy("rollback"); setMessage(null);
    try {
      const result = await rollbackSetup(binding.profileId, binding.receiptId);
      if (result.conflict) setMessage("Realm overrides changed later. Disconnect stopped to preserve those edits.");
      else { setBinding(null); setMessage(result.rolledBack ? "Realm binding removed. Codex files were unchanged." : "Binding was already removed."); }
    } finally { setBusy(null); }
  };

  return (
    <div className="form settings-panel codex-setup-panel">
      <p className="settings-note">Connect Realm to existing Codex sources. Realm stores references and explicit overrides; credentials and Codex files stay where they are.</p>
      <label className="field"><span>Realm profile</span>
        <select value={profileId} onChange={(event) => { setProfileId(event.target.value); setScan(null); setBinding(null); }}>
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
      </label>
      <label className="field"><span>Additional skill roots <small>(optional, one absolute path per line)</small></span>
        <textarea rows={3} value={rootsText} onChange={(event) => { setRootsText(event.target.value); setScan(null); }} placeholder="/Users/you/.codex/plugins/example/skills" />
      </label>
      <div className="field"><span>Realm profile overrides <small>(blank values inherit Codex)</small></span>
        <input aria-label="Model override" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Model: inherit Codex" />
        <input aria-label="Provider override" value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="Provider: inherit Codex" />
        <select aria-label="Reasoning override" value={reasoning} onChange={(event) => setReasoning(event.target.value)}><option value="">Reasoning: inherit Codex</option>{["low", "medium", "high", "xhigh", "max", "ultra"].map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <select aria-label="Permission override" value={policy} onChange={(event) => setPolicy(event.target.value)}><option value="inherit">Permissions: inherit Codex</option><option value="workspace">Ask before broader access</option><option value="readonly">Read only</option><option value="full">Full access, no prompts</option></select>
      </div>
      {!cwd && <p className="settings-hint" role="status">Selected profile needs a space before Realm can resolve project instructions.</p>}
      <div className="field import-actions"><button type="button" className="btn" disabled={!cwd || busy !== null} onClick={() => run(preview)}>{busy === "scan" ? "Scanning…" : scan ? "Scan again" : "Preview Codex setup"}</button></div>
      {scan && <>
        <div className="field"><span>Preview</span>
          <ul className="page-list import-sources">
            <li className="import-source-row"><strong>Runtime settings</strong><span className="muted">{scan.runtime.components.config}</span></li>
            <li className="import-source-row"><strong>Skills</strong><span className="muted">{scan.runtime.skills.length} found · {scan.runtime.components.skills}</span></li>
            <li className="import-source-row"><strong>Hooks</strong><span className="muted">{scan.runtime.hooks.length} found · {scan.runtime.components.hooks}</span></li>
            <li className="import-source-row"><strong>Connections</strong><span className="muted">{scan.runtime.connections.length} defined · authentication not checked</span></li>
          </ul>
        </div>
        {scan.warnings.map((warning) => <p key={warning} className="settings-hint">{warning}</p>)}
        <div className="field import-actions">
          <button type="button" className="btn primary" disabled={busy !== null || Boolean(binding)} onClick={() => run(connect)}>{busy === "apply" ? "Connecting…" : binding ? "Connected" : "Connect setup"}</button>
          {binding && <button type="button" className="btn" disabled={busy !== null} onClick={() => run(disconnect)}>{busy === "rollback" ? "Disconnecting…" : "Disconnect"}</button>}
        </div>
      </>}
      {message && <p className="settings-hint" role="status">{message}</p>}
    </div>
  );
}
