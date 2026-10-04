import { AGENT_MEMORY_CHANNEL, AGENT_META, SELECTABLE_AGENT_KINDS, memorySupportNote, type AgentKind, type MemorySource } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useState, type RefObject } from "react";
import { useApp } from "../../state/store";
import { MemoryDoc } from "./MemoryDoc";

/** The agents a space's memory reaches, and the ones it cannot: the channel table decides, never a
 *  list kept here. */
export const MEMORY_READERS: readonly AgentKind[] = SELECTABLE_AGENT_KINDS.filter((k) => AGENT_MEMORY_CHANNEL[k] !== "none");
const MEMORY_NON_READERS: readonly AgentKind[] = SELECTABLE_AGENT_KINDS.filter((k) => AGENT_MEMORY_CHANNEL[k] === "none");
const names = (ks: readonly AgentKind[]): string => ks.map((k) => AGENT_META[k].label).join(", ");
/** "Claude and Codex", for the line that says who reads it. */
export const memoryReaderNames = (): string => {
  const ls = MEMORY_READERS.map((k) => AGENT_META[k].label);
  return ls.length <= 1 ? (ls[0] ?? "") : `${ls.slice(0, -1).join(", ")} and ${ls.at(-1)}`;
};

/**
 * The memory of the space page's Memory tab (Plan 12 W3): this space's document, then how it reaches
 * an agent. The Library's Memory section draws the same two pieces with the inherited profile
 * document between them, through ScopeGroups — so they are exported apart as well as together.
 */
export function MemoryPanel({ spaceId, editorRef }: { spaceId: string;
  /** Lets a mount context (the space page's standing-instruction CTA) focus the document editor. */
  editorRef?: RefObject<HTMLTextAreaElement | null> }) {
  const memory = useApp((s) => s.spaceMemory[spaceId]);
  const refreshMemory = useApp((s) => s.refreshMemory);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => refreshMemory(spaceId)); }, [spaceId, refreshMemory, run]);
  if (!memory) return <div className="form settings-panel"><p className="env-empty">Loading…</p></div>;
  return (
    <div className="form settings-panel memory-panel">
      <div className="settings-row scope-doc-row"><SpaceMemoryDoc spaceId={spaceId} editorRef={editorRef} /></div>
      <MemoryReach spaceId={spaceId} />
    </div>
  );
}

/**
 * This space's document, wired to the store. Keyed by the space, so a draft never follows the page
 * from one space to the next.
 */
export function SpaceMemoryDoc({ spaceId, editorRef }: { spaceId: string; editorRef?: RefObject<HTMLTextAreaElement | null> }) {
  const memory = useApp((s) => s.spaceMemory[spaceId]);
  const saveMemoryDoc = useApp((s) => s.saveMemoryDoc);
  if (!memory) return <p className="env-empty">Loading…</p>;
  return (
    <MemoryDoc key={spaceId} label="Space memory document" doc={memory.doc} editorRef={editorRef}
      onSave={(text) => saveMemoryDoc(spaceId, text)}
      placeholder="Conventions, links, standing instructions — anything you would otherwise retype at the start of every session." />
  );
}

/**
 * How the document reaches an agent, as rows: who reads it, the opt-in AGENTS.md mirror, where the
 * file lives, and — folded — what one session actually loads. It was a disclosure called "Where this
 * goes" holding a paragraph, a switch sentence and a diagnostic; each is a row now, a label and its
 * control, and only the diagnostic stays folded, because it is the one occasional question.
 *
 * The AGENTS.md switch appears ONLY where the server would accept it (`agentsFile.writable`): a space
 * whose primary checkout is a linked directory Realm did not create shows the refusal reason instead
 * of a switch that can only error.
 */
export function MemoryReach({ spaceId }: { spaceId: string }) {
  const memory = useApp((s) => s.spaceMemory[spaceId]);
  const setAgentsFile = useApp((s) => s.setAgentsFile);
  const run = useApp((s) => s.run);
  if (!memory) return null;
  const af = memory.agentsFile;
  const reveal = window.realm?.files?.reveal;
  return (
    <>
      <h3 className="settings-head">How agents get it</h3>
      <div className="settings-group memory-reach">
        <div className="settings-row" title={`${names(MEMORY_NON_READERS)} take no per-session context, so nothing Realm manages reaches them.`}>
          <div className="settings-row-main">
            <span className="settings-row-name">Read by</span>
            <span className="settings-row-desc">Every new session of these agents, never written into their own config. Other agents take no per-session context.</span>
          </div>
          <span className="memory-readers">
            {MEMORY_READERS.map((k) => (
              <span key={k} className="memory-reader"><Icon name={AGENT_META[k].icon} size={14} colored />{AGENT_META[k].label}</span>
            ))}
          </span>
        </div>
        {af.writable || af.enabled ? (
          <label className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-name">Also write AGENTS.md</span>
              <span className="settings-row-desc">
                Agents started from a terminal in this folder read it too. Turning it off removes the
                file{af.exists && !af.managedByRealm ? " — except this one, which Realm did not write" : ""}.
              </span>
            </div>
            <input type="checkbox" role="switch" className="switch" aria-label="Write AGENTS.md into the space folder"
              title={af.path} checked={af.enabled} onChange={(e) => run(() => setAgentsFile(spaceId, e.target.checked))} />
          </label>
        ) : (
          // The server would refuse (not a Realm-created folder, or a foreign AGENTS.md sits there):
          // the reason is shown INSTEAD of a switch, never a switch that can only error.
          <div className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-name">AGENTS.md</span>
              <span className="settings-row-desc">No AGENTS.md here: {af.reason}.</span>
            </div>
          </div>
        )}
        <div className="settings-row memory-path-row">
          <div className="settings-row-main">
            <span className="settings-row-name">Stored at</span>
            <code className="env-path settings-row-desc">{memory.path}</code>
          </div>
          {/* Only where the bridge can do it: a button that reveals nothing is a promise broken. */}
          {reveal && <button type="button" className="btn-quiet" onClick={() => { void reveal(memory.path); }}>Show in Finder</button>}
        </div>
        <details className="settings-row settings-disclosure">
          <summary>
            <div className="settings-row-main">
              <span className="settings-row-name">What a session loads</span>
              <span className="settings-row-desc">The files each agent reads, session by session.</span>
            </div>
            <Icon name="chevronRight" size={14} className="settings-disclosure-caret" />
          </summary>
          <div className="settings-disclosure-body"><SourcesView spaceId={spaceId} /></div>
        </details>
      </div>
    </>
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
