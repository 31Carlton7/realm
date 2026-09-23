import { useEffect, useState } from "react";
import { AGENT_META, SELECTABLE_AGENT_KINDS, type AgentKind } from "@realm/contracts";
import { agentAvailability, isBlocked } from "../state/agent-availability";
import { FAN_OUT_MAX, useApp } from "../state/store";
import { Sheet } from "./Sheet";
import { Spinner } from "./Spinner";

/**
 * Start several agents on one brief.
 *
 * The brief comes first because it is the question the user arrived with; the count and the agent
 * are what the product needs to know, and both have an answer already filled in. Nothing here opens
 * a pane — the agents land on the Agents page, which is where a batch is read.
 *
 * The worktree switch is on by default and says what turning it off means, because that is the one
 * choice on this sheet a person can get wrong in a way that costs them work: several agents editing
 * one checkout overwrite each other, and the loss is silent.
 */
export function FanOutSheet() {
  const closeSheet = useApp((s) => s.closeSheet);
  const fanOut = useApp((s) => s.fanOutAgents);
  const setView = useApp((s) => s.setAgentsView);
  const run = useApp((s) => s.run);
  const lastAgent = useApp((s) => s.lastAgentKind);
  const space = useApp((s) => s.spaces.find((sp) => sp.id === s.activeSpaceId));
  const probe = useApp((s) => s.agentProbe);
  const probeAgents = useApp((s) => s.probeAgents);
  /* Asked for here rather than assumed. Nothing else on this page probes — the prompter does it on
     mount, and the Agents page is reachable without ever opening a session — so a fresh launch would
     offer every agent Realm knows about, including the ones this Mac cannot run. Unforced, so it
     rides the server's TTL cache and costs nothing when a session pane has already asked. */
  useEffect(() => { run(() => probeAgents()); }, [probeAgents, run]);
  /* Only the agents this Mac can actually run. A kind the probe has said nothing about stays in the
     list — `unknown` is not an absence, and dropping it would hide a working agent during boot. */
  const kinds = SELECTABLE_AGENT_KINDS.filter((k) => !isBlocked(agentAvailability(k, probe)));
  const [brief, setBrief] = useState("");
  const [count, setCount] = useState(3);
  /* The PICK, which is null until the user makes one — the value on the control is derived below.
     Seeding state with the last-used agent would be a claim made before the probe has answered: the
     select would show a kind with no option behind it, and submit it anyway. */
  const [picked, setPicked] = useState<AgentKind | null>(null);
  const agentKind = pickAgent(kinds, picked, lastAgent);
  const [worktrees, setWorktrees] = useState(true);
  const [busy, setBusy] = useState(false);
  const ready = brief.trim().length > 0 && !busy;
  const submit = () => {
    if (!ready) return;
    setBusy(true);
    run(async () => {
      try {
        const started = await fanOut({ brief, count, agentKind, worktrees });
        // The wall, not the list: a batch just started is entirely "Working", and the list would
        // open on the same rows ranked by a question none of them has an answer to yet.
        if (started.length > 0) { setView("wall"); closeSheet(); }
      } finally { setBusy(false); }
    });
  };
  return (
    <Sheet title="Start agents" onClose={closeSheet} width={470}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="field">
          <span>Brief</span>
          <textarea className="fan-out-brief" value={brief} rows={4} autoFocus
            placeholder="Find and fix the flake in the checkpoint tests."
            onChange={(e) => setBrief(e.target.value)}
            /* ⌘↩ sends, as it does in the prompter. Enter alone stays a newline: this is a
               paragraph, not a one-line field, and a brief cut off at its first sentence is the
               mistake that costs a whole batch. */
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }} />
        </label>
        <div className="fan-out-row">
          <label className="field">
            <span>Agents</span>
            <input type="number" min={1} max={FAN_OUT_MAX} value={count} aria-label="How many agents"
              onChange={(e) => setCount(clampCount(e.target.valueAsNumber))} />
          </label>
          <label className="field">
            <span>Agent</span>
            <select value={agentKind} aria-label="Which agent" onChange={(e) => setPicked(e.target.value as AgentKind)}>
              {kinds.map((k) => <option key={k} value={k}>{AGENT_META[k].label}</option>)}
            </select>
          </label>
        </div>
        <label className="fan-out-switch">
          <input type="checkbox" checked={worktrees} onChange={(e) => setWorktrees(e.target.checked)} />
          <span>
            <strong>A worktree each</strong>
            <span className="fan-out-note">
              {worktrees
                ? <>One <code>git worktree</code> per agent in {space ? <>{space.name}</> : "this space"}, so they cannot overwrite each other.</>
                : <>All {count} run in the space folder and will edit the same files at once.</>}
            </span>
          </span>
        </label>
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={closeSheet}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!ready}>
            {busy ? <><Spinner size={14} /> Starting…</> : `Start ${count} ${count === 1 ? "agent" : "agents"}`}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** A number input hands back NaN for an empty field and anything at all for a typed one; the store
 *  clamps too, but a field that shows 900 until submit has already told the user a lie. */
export function clampCount(n: number): number {
  return Number.isFinite(n) ? Math.min(FAN_OUT_MAX, Math.max(1, Math.trunc(n))) : 1;
}

/**
 * Which agent the control is actually on: the user's pick, else the last one they used, else the
 * first this Mac can run — and never one that is not in the list.
 *
 * The offer and the value are the same list or they are not a control. A `<select>` whose value
 * names no option renders as its first row while holding the other kind, so what the user reads and
 * what the batch is started on are two different agents, and the second one is the one that is not
 * installed. `offered` is empty only if every kind is blocked, which is not a state this sheet can
 * do anything useful in; `claude` keeps the type honest and the Start button is what a user who
 * has no agents installed runs into.
 */
export function pickAgent(offered: readonly AgentKind[], picked: AgentKind | null, last: AgentKind | null): AgentKind {
  for (const k of [picked, last]) if (k && offered.includes(k)) return k;
  return offered[0] ?? "claude";
}
