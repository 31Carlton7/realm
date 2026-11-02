import { Icon, type IconName } from "@realm/ui";
import { useEffect, useRef, type CSSProperties } from "react";
import { useApp, useAppStore, type NewTabTool } from "../../state/store";
import { openSideTool, sideToolOffered } from "../../components/side-tools";
import { useDissolve } from "../../components/ScrollFades";
import { useMinuteClock } from "../settings/usage/PlanCard";
import { age } from "../code-review/code-review-model";
import type { PaneProps } from "../registry";
import { sessionTree, STATE_WORD, teammateMark } from "./teammate-model";

const TOOLS: readonly { tool: NewTabTool; label: string; icon: IconName; hint: string }[] = [
  { tool: "documents", label: "Files", icon: "documents", hint: "Its folder, in Documents" },
  { tool: "terminal", label: "Terminal", icon: "terminal", hint: "A shell in its folder" },
  { tool: "simulator", label: "Simulator", icon: "simulator", hint: "A device on this Mac" },
];

/**
 * A teammate's computer, as a tab of its chat's side panel (`computer` item, refId = the teammate):
 * where it works and whether it is working, the panes it works in, and every session it started.
 *
 * Quiet rows and no boxes, as Reason draws its right panel. The machine line says the state in words
 * beside the dot, with Stop while anything of it runs; Files, Terminal and Simulator open beside its
 * chat in its folder, as the side panel's own "+" would; and Sessions lists what it started, newest
 * first, with the sessions handed on from each nested under it and counted. A session opens beside
 * the chat for a look (a peek), and opens properly from there.
 */
export function ComputerPane({ item }: PaneProps) {
  const teammate = useApp((s) => s.teammates[item.spaceId]?.find((t) => t.id === item.refId));
  const sessions = useApp((s) => s.teammateSessions[item.refId]);
  const loadTeammateSessions = useApp((s) => s.loadTeammateSessions);
  const peekSession = useApp((s) => s.peekSession);
  const interruptSession = useApp((s) => s.interruptSession);
  const run = useApp((s) => s.run);
  const store = useAppStore();
  const now = useMinuteClock();
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  useEffect(() => { run(() => loadTeammateSessions(item.refId)); }, [run, loadTeammateSessions, item.refId]);
  if (!teammate) return <div className="tm-computer" ref={scroller}><p className="tm-empty">This teammate was archived.</p></div>;
  const home = teammate.homeSessionId;
  const list = sessionTree(sessions ?? teammate.taskSessions);
  const live = (sessions ?? teammate.taskSessions).filter((s) => s.state !== "idle" && s.teammateId === teammate.id);
  const mark = teammateMark(teammate.state, false);
  const stop = () => run(async () => {
    await Promise.all([...(home ? [home] : []), ...live.map((s) => s.id)].map((id) => interruptSession(id)));
  });
  const open = (tool: NewTabTool) => run(async () => { if (home) await openSideTool(store.getState(), home, tool); });
  return (
    <div className="tm-computer" ref={scroller}>
      <div className="tm-machine">
        <Icon name="laptop" size={16} />
        <span className="tm-machine-name">This Mac</span>
        <span className="tm-machine-state">
          {mark && <span className="status-dot item-status" data-status={mark.mark} />}
          {STATE_WORD[teammate.state]}
        </span>
        {teammate.state !== "idle" && (
          <button type="button" className="btn tm-stop" title={`Stop everything ${teammate.name} is running`} onClick={stop}>
            <Icon name="stop" size={12} />Stop
          </button>
        )}
      </div>
      <div className="tm-tools">
        {TOOLS.filter((t) => sideToolOffered(t.tool)).map((t) => (
          <button key={t.tool} type="button" className="tm-tool" title={t.hint} disabled={!home} onClick={() => open(t.tool)}>
            <Icon name={t.icon} size={16} /><span>{t.label}</span>
          </button>
        ))}
      </div>
      <h3 className="tm-caption">Sessions</h3>
      {list.length === 0 ? (
        <p className="tm-empty">Nothing yet. What {teammate.name} starts for you is listed here.</p>
      ) : (
        <ul className="tm-sessions">
          {list.map(({ session: s, depth, handoffs }) => {
            const m = teammateMark(s.state, s.unread);
            return (
              <li key={s.id} style={{ "--tm-depth": depth } as CSSProperties}>
                <button type="button" className="tm-session" data-unread={m?.mark === "unseen" || undefined}
                  aria-label={`${s.title}${m ? ` — ${m.label}` : ""}, ${age(s.updatedAt, now)}${handoffs ? `, ${handoffs} handed on` : ""}`}
                  title={s.title} onClick={() => run(() => peekSession(s.id, item.spaceId))}>
                  {depth > 0 && <span className="tm-handoff-mark" aria-hidden="true">↳</span>}
                  <span className="tm-session-title">{s.title}</span>
                  {handoffs > 0 && <span className="tm-handoffs" aria-hidden="true">↳ {handoffs}</span>}
                  <span className="tm-age">{age(s.updatedAt, now)}</span>
                  <span className="tm-dot">{m && <span className="status-dot item-status" data-status={m.mark} />}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
