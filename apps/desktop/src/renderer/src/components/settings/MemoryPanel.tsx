import { AGENT_META, MEMORY_DOC_MAX, SELECTABLE_AGENT_KINDS, memorySupportNote, type MemorySource } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useState, type RefObject } from "react";
import { useApp } from "../../state/store";

const fmt = (num: number): string => num.toLocaleString("en-US");

/**
 * The memory tab of the space page (W5, sheet-era; a pane tab since Plan 12 W3): this space's Realm
 * memory document, the opt-in
 * `AGENTS.md`, and what each agent actually loads.
 *
 * The cap is surfaced, never enforced by truncation: past MEMORY_DOC_MAX the save is refused with the
 * overage named, and the text stays exactly as typed. The server would refuse too — the client check
 * exists so the refusal is explained before the round trip, not so the doc can be quietly trimmed.
 *
 * The AGENTS.md toggle appears ONLY where the server would accept it (`agentsFile.writable`): a space
 * whose primary checkout is a linked directory Realm did not create shows the refusal reason instead
 * of a switch that can only error.
 */
export function MemoryPanel({ spaceId, editorRef }: { spaceId: string;
  /** Lets a mount context (the space page's standing-instruction CTA) focus the document editor. */
  editorRef?: RefObject<HTMLTextAreaElement | null> }) {
  const memory = useApp((s) => s.spaceMemory[spaceId]);
  const refreshMemory = useApp((s) => s.refreshMemory);
  const saveMemoryDoc = useApp((s) => s.saveMemoryDoc);
  const setAgentsFile = useApp((s) => s.setAgentsFile);
  const run = useApp((s) => s.run);
  const [draft, setDraft] = useState<string | null>(null); // null = not edited; the stored doc shows
  useEffect(() => { run(() => refreshMemory(spaceId)); }, [spaceId, refreshMemory, run]);
  useEffect(() => { setDraft(null); }, [spaceId]);

  if (!memory) return <div className="form settings-panel"><p className="env-empty">Loading…</p></div>;

  const text = draft ?? memory.doc;
  const over = text.length - MEMORY_DOC_MAX;
  const dirty = draft !== null && draft !== memory.doc;
  const af = memory.agentsFile;

  /*
   * One thing you write, one thing you can check.
   *
   * This page was three co-equal blocks — an editor, a file-mirroring switch, and a per-session
   * diagnostic — stacked with the same weight and no hierarchy, which is why it read as confusing:
   * only ONE of them is a thing you do. The other two answer "how does this actually reach the
   * agent", which is one occasional question, so they fold together behind one disclosure.
   *
   * The editor leads and is labelled by what it MEANS rather than by what it is called internally:
   * "what every session in this space knows" is the sentence a person is trying to write.
   */
  return (
    <div className="form settings-panel memory-panel">
      <div className="field">
        <span>What every session in this space knows</span>
        <textarea ref={editorRef} className="memory-doc" aria-label="Space memory document" value={text} rows={12} spellCheck={false}
          onChange={(e) => setDraft(e.target.value)} placeholder="Conventions, links, standing instructions — anything you would otherwise retype at the start of every session." />
        <div className="memory-meta">
          {/* The count is chrome until it matters. It used to sit at full weight beside every save,
              reporting a limit almost nobody is near. */}
          <span className="settings-hint" data-tone={over > 0 ? "danger" : undefined} data-quiet={over <= 0 || undefined}>
            {over > 0
              ? `${fmt(text.length)} / ${fmt(MEMORY_DOC_MAX)} — over by ${fmt(over)} characters. Trim it down; Realm will not truncate it.`
              : `${fmt(text.length)} / ${fmt(MEMORY_DOC_MAX)}`}
          </span>
          <button type="button" className="btn primary" disabled={!dirty || over > 0}
            onClick={() => run(async () => { await saveMemoryDoc(spaceId, text); setDraft(null); })}>
            {/* A stable label. A button whose NAME changes with its state ("Save" → "Saved") makes
                its accessible name a status, which is the one thing a name must not be. */}
            Save memory
          </button>
        </div>
      </div>

      {/* The mechanics, folded. Everything here answers one question — how this reaches an agent —
          and it is a question asked once, not on every visit. */}
      <details className="memory-details">
        <summary>Where this goes</summary>
        <div className="memory-details-body">
          <p className="settings-hint">
            Stored at <code className="env-path">{memory.path}</code>, and travels into every new
            Claude and Codex session in this space — never into any agent's own config.
          </p>
          {af.writable || af.enabled ? (
            <label className="settings-inline-toggle">
              <input type="checkbox" role="switch" className="switch" aria-label="Write AGENTS.md into the space folder"
                checked={af.enabled} onChange={(e) => run(() => setAgentsFile(spaceId, e.target.checked))} />
              <span className="settings-agent-note">
                Also write it to <code className="env-path">{af.path}</code>, so agents started from a
                terminal in this folder pick it up too. Turning it off removes the file{af.exists && !af.managedByRealm ? " — except this one, which Realm did not write" : ""}.
              </span>
            </label>
          ) : (
            // The server would refuse (not a Realm-created folder, or a foreign AGENTS.md sits there):
            // the reason is shown INSTEAD of a toggle, never a switch that can only error.
            <p className="settings-hint">No AGENTS.md here: {af.reason}.</p>
          )}
          <SourcesView spaceId={spaceId} />
        </div>
      </details>
    </div>
  );
}

const ORIGIN_LABEL = { user: "user file", project: "project file", import: "imported", reported: "reported by the agent" } as const;
const VIA_LABEL = { cli: "loaded by the CLI", realm: "re-injected by Realm", none: "not loaded" } as const;
const BASIS_LABEL = { modeled: "modeled by Realm", reported: "reported by the agent", none: "no report yet" } as const;

/**
 * "What each agent actually loads", per session, on the authority `memory.sources` names: Claude
 * modeled from the paths the CLI reads, Codex from its own reported `instructionSources`, Cursor an
 * honest nothing. With no session to ask about, the per-agent honesty lines stand in.
 */
function SourcesView({ spaceId }: { spaceId: string }) {
  const sessions = useApp((s) => s.sessions);
  const sources = useApp((s) => s.sessionMemorySources);
  const refreshMemorySources = useApp((s) => s.refreshMemorySources);
  const run = useApp((s) => s.run);
  const here = Object.values(sessions).filter((s) => s.spaceId === spaceId);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const sessionId = pickedId ?? here[0]?.id ?? null;
  useEffect(() => { if (sessionId) run(() => refreshMemorySources(sessionId)); }, [sessionId, refreshMemorySources, run]);

  if (here.length === 0) {
    return (
      <div className="field">
        <span className="memory-sub">What each agent loads</span>
        <ul className="settings-list">
          {SELECTABLE_AGENT_KINDS.map((kind) => (
            <li key={kind} className="settings-agent-row">
              <Icon name={AGENT_META[kind].icon} size={14} colored />
              <span className="settings-agent-note">{memorySupportNote(kind)}</span>
            </li>
          ))}
        </ul>
        <p className="settings-hint">Start a session to see the exact files its agent loads.</p>
      </div>
    );
  }

  const m = sessionId ? sources[sessionId] : undefined;
  return (
    <div className="field">
      <span className="memory-sub">What this session's agent loads</span>
      <select aria-label="Session" value={sessionId ?? ""} onChange={(e) => setPickedId(e.target.value)}>
        {here.map((s) => <option key={s.id} value={s.id}>{s.title} · {AGENT_META[s.agentKind].label}</option>)}
      </select>
      {m && (
        <>
          <p className="settings-agent-note">
            {m.note} <span className="settings-chip">{BASIS_LABEL[m.basis]}</span>
          </p>
          {m.channel !== "none" && (
            <p className="settings-hint">{m.realmMemoryInjected ? "This space's Realm memory travels into this session." : "This space's Realm memory is empty, so nothing extra travels into this session."}</p>
          )}
          {m.sources.length > 0 && (
            <ul className="settings-list">
              {m.sources.map((f: MemorySource) => (
                <li key={f.path} className="settings-source-row" data-missing={!f.exists || undefined}>
                  <code className="env-path">{f.path}</code>
                  <span className="settings-hint">{ORIGIN_LABEL[f.origin]} · {f.exists ? VIA_LABEL[f.via] : "missing"}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
