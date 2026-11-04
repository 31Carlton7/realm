import { Icon, type IconName } from "@realm/ui";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Item } from "@realm/contracts";
import { useApp, useAppStore, type NewTabTool } from "../../state/store";
import { openSideTool, sideToolOffered } from "../../components/side-tools";
import { useDissolve } from "../../components/ScrollFades";
import { RenameInput } from "../../components/RenameInput";
import { Spinner } from "../../components/Spinner";
import { useItemContextMenu } from "../../components/sidebar/ItemContextMenu";
import { useMinuteClock } from "../settings/usage/PlanCard";
import { age } from "../code-review/code-review-model";
import type { PaneProps } from "../registry";
import { sessionTree, STATE_WORD, teammateMark, type SessionNode } from "./teammate-model";

/** How many rows Sessions shows before "Show all". */
const SESSIONS_SHOWN = 8;

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
 *
 * Each row carries the sidebar row's menu (Rename, Archive and the rest) and one mark at its far end:
 * the amber dot while it waits on you, the spinner while it works, else its age. Unread is the
 * title's weight, not a dot.
 */
export function ComputerPane({ item }: PaneProps) {
  const teammate = useApp((s) => s.teammates[item.spaceId]?.find((t) => t.id === item.refId));
  const sessions = useApp((s) => s.teammateSessions[item.refId]);
  const loadTeammateSessions = useApp((s) => s.loadTeammateSessions);
  const interruptSession = useApp((s) => s.interruptSession);
  const run = useApp((s) => s.run);
  const store = useAppStore();
  const now = useMinuteClock();
  const items = useApp((s) => s.items);
  const [showAll, setShowAll] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  useEffect(() => { run(() => loadTeammateSessions(item.refId)); }, [run, loadTeammateSessions, item.refId]);
  if (!teammate) return <div className="tm-computer" ref={scroller}><p className="tm-empty">This teammate was archived.</p></div>;
  const home = teammate.homeSessionId;
  const rows = new Map(items.filter((i) => i.kind === "session").map((i) => [i.refId, i]));
  // An archived session leaves the list, as it leaves the sidebar's; Unarchive brings it back.
  const list = sessionTree((sessions ?? teammate.taskSessions).filter((s) => !rows.get(s.id)?.archived));
  const shown = showAll ? list : list.slice(0, SESSIONS_SHOWN);
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
        <>
          <ul className="tm-sessions">
            {shown.map((node) => <SessionRow key={node.session.id} node={node} item={rows.get(node.session.id)} spaceId={item.spaceId} now={now} />)}
          </ul>
          {list.length > SESSIONS_SHOWN && (
            <button type="button" className="tm-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : <>Show all <span className="item-count">{list.length}</span></>}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** One of the teammate's sessions. A click looks at it beside the chat, or opens it where there is no
 *  chat on screen to look beside; a right-click is the sidebar row's menu. */
function SessionRow({ node: { session: s, depth, handoffs }, item, spaceId, now }:
  { node: SessionNode; item: Item | undefined; spaceId: string; now: number }) {
  const peekSession = useApp((st) => st.peekSession);
  const revealSession = useApp((st) => st.revealSession);
  const run = useApp((st) => st.run);
  const [renaming, setRenaming] = useState(false);
  const { onContextMenu, element } = useItemContextMenu(() => setRenaming(true));
  const title = item?.title ?? s.title;
  const m = teammateMark(s.state, s.unread);
  const when = age(s.updatedAt, now);
  const open = () => run(async () => { if (!(await peekSession(s.id, spaceId))) await revealSession(s.id, spaceId); });
  return (
    <li style={{ "--tm-depth": depth } as CSSProperties} onContextMenu={item ? onContextMenu(item) : undefined}>
      {renaming && item ? <RenameInput item={item} onDone={() => setRenaming(false)} /> : (
        <button type="button" className="tm-session" data-unread={s.unread || undefined}
          aria-label={`${title}${m ? ` — ${m.label}` : ""}, ${when}${handoffs ? `, ${handoffs} handed on` : ""}`}
          title={title} onClick={open}>
          {depth > 0 && <span className="tm-handoff-mark" aria-hidden="true">↳</span>}
          <span className="tm-session-title">{title}</span>
          {handoffs > 0 && <span className="tm-handoffs" aria-hidden="true">↳ {handoffs}</span>}
          <span className="tm-trail">
            {s.state === "needs-you" ? <span className="status-dot item-status" data-status="waiting_permission" />
              : s.state === "working" ? <Spinner size={14} />
              : <span className="tm-age">{when}</span>}
          </span>
        </button>
      )}
      {element}
    </li>
  );
}
