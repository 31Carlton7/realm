import { Icon, TeammateIcon, type IconName } from "@realm/ui";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Item, MemoryPressure, SessionOutcome, Teammate, TeammateTaskSession, TerminalStatus } from "@realm/contracts";
import { useApp, useAppStore } from "../../state/store";
import { rpc } from "../../rpc/client";
import { useDissolve } from "../../components/ScrollFades";
import { RenameInput } from "../../components/RenameInput";
import { Spinner } from "../../components/Spinner";
import { useItemContextMenu } from "../../components/sidebar/ItemContextMenu";
import { useMinuteClock } from "../settings/usage/PlanCard";
import { age } from "../code-review/code-review-model";
import type { PaneProps } from "../registry";
import {
  doneDays, firstRows, headline, liveWork, macResources, plainTitle, resourcesLine, sessionTree, stopLabel, todayLine,
  type MacResource, type MacResourceKind, type SessionNode,
} from "./teammate-model";

/** How many finished sessions Done shows before "Show all". */
const DONE_SHOWN = 8;
/** The panel's width from which Done stands beside Now and On this Mac rather than under them. */
export const WIDE_FROM = 760;

const RESOURCE_ICON: Record<MacResourceKind, IconName> = {
  terminal: "terminal", build: "package", server: "serverStack", simulator: "simulator", browser: "browser",
};

/**
 * A teammate's computer, as a tab of its chat's side panel (`computer` item, refId = the teammate):
 * a report on what it is doing on this Mac, read from the top.
 *
 * The head says in words what is live, what it holds open and what today came to, and Stop names
 * what it stops. Now is the live work, the session waiting on you first with Answer, then each
 * working session with its current step and how long it has run. Done is the finished work by day,
 * each row ending in what it produced, as far as its log recorded one. On this Mac lists the
 * terminals, devices and browser tabs its sessions hold, each with Open and Stop. Wide, Done stands
 * beside the other two; narrow, it comes before On this Mac.
 *
 * Bold is unread, the spinner is working, and amber is only for needs you and failed.
 */
export function ComputerPane({ item }: PaneProps) {
  const teammate = useApp((s) => s.teammates[item.spaceId]?.find((t) => t.id === item.refId));
  const team = useApp((s) => s.teammates[item.spaceId]);
  const sessions = useApp((s) => s.teammateSessions[item.refId]);
  const loadTeammateSessions = useApp((s) => s.loadTeammateSessions);
  const interruptSession = useApp((s) => s.interruptSession);
  const run = useApp((s) => s.run);
  const items = useApp((s) => s.items);
  const layout = useApp((s) => s.layout);
  const sidePanes = useApp((s) => s.view?.sidePanes);
  const sessionTerminals = useApp((s) => s.sessionTerminals);
  const homeStatus = useApp((s) => teammate?.homeSessionId ? s.sessionStatus[teammate.homeSessionId] : undefined);
  const simulators = useApp((s) => s.simulatorState);
  const now = useMinuteClock();
  const [showAll, setShowAll] = useState(false);
  const [wide, setWide] = useState(false);
  const [terminals, setTerminals] = useState<ReadonlyMap<string, TerminalStatus>>(new Map());
  const [pressure, setPressure] = useState<{ level: MemoryPressure; why: string | null } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  useEffect(() => { run(() => loadTeammateSessions(item.refId)); }, [run, loadTeammateSessions, item.refId]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // The panel's own width, padding included: the content box reads 32px under it.
    const ro = new ResizeObserver(([e]) => setWide((e?.borderBoxSize?.[0]?.inlineSize ?? e?.contentRect.width ?? 0) >= WIDE_FROM));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // What each terminal runs and since when; a window that cannot ask lists its terminals as open.
  const terminalItems = items.filter((i) => i.kind === "terminal").map((i) => i.refId).join();
  useEffect(() => {
    let live = true;
    // `rpc()` throws where no server was handed to the window; the list is then just not known.
    Promise.resolve().then(() => rpc().call("terminals.list", { spaceId: item.spaceId }))
      .then((list) => { if (live) setTerminals(new Map(list.map((t) => [t.terminalId, t]))); }, () => {});
    return () => { live = false; };
  }, [item.spaceId, terminalItems, now]);
  // The machine line, said only when memory is short.
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => rpc().call("resources.snapshot", { fresh: false }))
      .then((r) => { if (live) setPressure({ level: r.machine.pressure, why: r.machine.pressureWhy }); }, () => {});
    return () => { live = false; };
  }, [now]);

  const all = sessions ?? teammate?.taskSessions ?? [];
  const rows = new Map(items.filter((i) => i.kind === "session").map((i) => [i.refId, i]));
  // An archived session leaves the list, as it leaves the sidebar's; Unarchive brings it back.
  const listed = all.filter((s) => !rows.get(s.id)?.archived);
  const needsYou = listed.filter((s) => s.state === "needs-you");
  const working = listed.filter((s) => s.state === "working");
  const done = doneDays(sessionTree(listed.filter((s) => s.state === "idle")), now);
  const doneCount = done.reduce((n, d) => n + d.rows.length, 0);
  const home = teammate?.homeSessionId ?? null;
  const resources = macResources({
    sessionIds: [...(home ? [home] : []), ...listed.map((s) => s.id)], items, layout, sidePanes: sidePanes ?? {},
    sessionTerminals, terminals, simulators, now,
  });
  if (!teammate) return <div className="tm-computer" ref={scroller}><p className="tm-empty">This teammate was archived.</p></div>;

  const handles = (team ?? [teammate]).map((t) => t.handle);
  const byId = new Map((team ?? [teammate]).map((t) => [t.id, t]));
  const work = liveWork(teammate.id, home, homeStatus, listed);
  const stop = () => run(async () => { await Promise.all(work.stops.map((id) => interruptSession(id))); });
  const head = headline(work.working, work.needsYou);
  const today = todayLine(listed, now);
  const onMac = resourcesLine(resources);
  const shown = showAll ? done : firstRows(done, DONE_SHOWN);
  const tight = pressure && (pressure.level === "warn" || pressure.level === "critical") ? pressure : null;

  const nowSection = (
    <section className="tm-section" aria-label="Now">
      <h3 className="tm-caption">Now</h3>
      {needsYou.length + working.length === 0 ? (
        <p className="tm-empty">Nothing running. What {teammate.name} starts shows here while it works.</p>
      ) : (
        <ul className="tm-card tm-now">
          {[...needsYou, ...working].map((s) => (
            <NowRow key={s.id} s={s} owner={byId.get(s.teammateId)} title={plainTitle(rows.get(s.id)?.title ?? s.title, handles)} spaceId={item.spaceId} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
  const doneSection = (
    <section className="tm-section" aria-label="Done">
      <h3 className="tm-caption">Done</h3>
      {doneCount === 0 ? (
        <p className="tm-empty">Nothing finished yet. What {teammate.name} finishes is listed here, with what came of it.</p>
      ) : (
        <>
          {shown.map((day) => (
            <div key={day.label} className="tm-day">
              <h4 className="tm-day-label">{day.label}</h4>
              <ul className="tm-sessions">
                {day.rows.map((node) => (
                  <DoneRow key={node.session.id} node={node} owner={byId.get(node.session.teammateId)} item={rows.get(node.session.id)}
                    title={plainTitle(rows.get(node.session.id)?.title ?? node.session.title, handles)} spaceId={item.spaceId} now={now} />
                ))}
              </ul>
            </div>
          ))}
          {doneCount > DONE_SHOWN && (
            <button type="button" className="tm-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : <>Show all <span className="item-count">{doneCount}</span></>}
            </button>
          )}
        </>
      )}
    </section>
  );
  const macSection = (
    <section className="tm-section" aria-label="On this Mac">
      <h3 className="tm-caption">On this Mac</h3>
      {resources.length === 0 ? (
        <p className="tm-empty">Nothing open. Terminals, devices and browser tabs its sessions open are listed here.</p>
      ) : (
        <ul className="tm-card tm-resources">
          {resources.map((r) => <ResourceRow key={r.itemId} r={r} />)}
        </ul>
      )}
      {tight && <p className="tm-machine-note">Memory is short{tight.why ? `: ${tight.why}` : ""}</p>}
    </section>
  );

  return (
    <div className="tm-computer" ref={scroller} data-wide={wide || undefined}>
      <header className="tm-report-head">
        <div className="tm-report-top">
          <span className="tm-report-where"><Icon name="laptop" size={14} /><span>{teammate.name}'s work on this Mac</span></span>
          {work.stops.length > 0 && (
            <button type="button" className="btn tm-stop" title={`Stop everything ${teammate.name} is running`} onClick={stop}>
              <Icon name="stop" size={12} />{stopLabel(work.stops.length, work.live)}
            </button>
          )}
        </div>
        <p className="tm-headline">
          {head.working}
          {head.needsYou && <> · <span className="tm-needs">{head.needsYou}</span></>}
        </p>
        {onMac && <p className="tm-report-line">{onMac}</p>}
        {today && <p className="tm-report-line">{today}</p>}
      </header>
      {wide ? (
        <div className="tm-columns">
          <div className="tm-column">{nowSection}{macSection}</div>
          <div className="tm-column">{doneSection}</div>
        </div>
      ) : <>{nowSection}{doneSection}{macSection}</>}
    </div>
  );
}

/** The teammate a row's session runs on: the session's own, for work handed to another teammate. */
function OwnerIcon({ owner }: { owner: Teammate | undefined }) {
  return <span className="tm-row-icon">{owner ? <TeammateIcon icon={owner.icon} size={16} lead={owner.lead} /> : <Icon name="session" size={16} />}</span>;
}

/** A live session: what it is doing now and for how long, or, waiting on you, Answer. */
function NowRow({ s, owner, title, spaceId, now }: { s: TeammateTaskSession; owner: Teammate | undefined; title: string; spaceId: string; now: number }) {
  const revealSession = useApp((st) => st.revealSession);
  const peekSession = useApp((st) => st.peekSession);
  const run = useApp((st) => st.run);
  const step = useApp((st) => st.sessionActivity[s.id]?.text ?? null);
  const since = useApp((st) => st.sessionUpdatedAt[s.id] ?? s.updatedAt);
  const waiting = s.state === "needs-you";
  const open = () => run(async () => { if (!(await peekSession(s.id, spaceId))) await revealSession(s.id, spaceId); });
  return (
    <li className="tm-now-row" data-unread={s.unread || undefined} data-state={s.state}>
      <OwnerIcon owner={owner} />
      <button type="button" className="tm-now-main" onClick={open} title={title}
        aria-label={`${title} — ${waiting ? "needs you" : `working, ${age(since, now)}`}`}>
        <span className="tm-session-title">{title}</span>
        {step && <span className="tm-step">{step}</span>}
      </button>
      {waiting ? (
        <>
          <button type="button" className="btn tm-answer" onClick={() => run(async () => { await revealSession(s.id, spaceId); })}>Answer</button>
          <span className="status-dot item-status" data-status="waiting_permission" aria-hidden="true" />
        </>
      ) : (
        <span className="tm-trail"><span className="tm-age">{age(since, now)}</span><Spinner size={14} /></span>
      )}
    </li>
  );
}

const outcomeIcon = (o: SessionOutcome): IconName => (o.kind === "failed" ? "errorCircle" : o.kind === "release" ? "rocket" : o.merged ? "merged" : "pullRequest");
const outcomeWords = (o: SessionOutcome): string => (o.kind === "failed" ? "Failed" : o.kind === "release" ? `${o.tag} shipped` : `#${o.number} ${o.merged ? "merged" : "open"}`);

/** A finished session, ending in what it produced. A click looks at it beside the chat, or opens it
 *  where there is no chat on screen to look beside; a right-click is the sidebar row's menu. */
function DoneRow({ node: { session: s, depth, handoffs }, owner, item, title, spaceId, now }:
  { node: SessionNode; owner: Teammate | undefined; item: Item | undefined; title: string; spaceId: string; now: number }) {
  const peekSession = useApp((st) => st.peekSession);
  const revealSession = useApp((st) => st.revealSession);
  const run = useApp((st) => st.run);
  const [renaming, setRenaming] = useState(false);
  const { onContextMenu, element } = useItemContextMenu(() => setRenaming(true));
  const when = age(s.updatedAt, now);
  const o = s.outcome ?? null;
  const open = () => run(async () => { if (!(await peekSession(s.id, spaceId))) await revealSession(s.id, spaceId); });
  return (
    <li style={{ "--tm-depth": depth } as CSSProperties} onContextMenu={item ? onContextMenu(item) : undefined}>
      {renaming && item ? <RenameInput item={item} onDone={() => setRenaming(false)} /> : (
        <button type="button" className="tm-session" data-unread={s.unread || undefined}
          aria-label={`${title}${o ? ` — ${outcomeWords(o)}` : ""}, ${when}${handoffs ? `, ${handoffs} handed on` : ""}`}
          title={title} onClick={open}>
          {depth > 0 && <span className="tm-handoff-mark" aria-hidden="true">↳</span>}
          <OwnerIcon owner={owner} />
          <span className="tm-session-body">
            <span className="tm-session-line">
              <span className="tm-session-title">{title}</span>
              {handoffs > 0 && <span className="tm-handoffs" aria-hidden="true">↳ {handoffs}</span>}
            </span>
            {o?.kind === "failed" && o.reason && <span className="tm-failed-why">{o.reason}</span>}
          </span>
          {o && <span className="tm-outcome" data-kind={o.kind}><Icon name={outcomeIcon(o)} size={12} />{outcomeWords(o)}</span>}
          <span className="tm-age">{when}</span>
        </button>
      )}
      {element}
    </li>
  );
}

/** Something a session holds open, with its state, Open, and Stop while there is anything to stop. */
function ResourceRow({ r }: { r: MacResource }) {
  const store = useAppStore();
  const run = useApp((st) => st.run);
  const applySimulatorState = useApp((st) => st.applySimulatorState);
  const open = () => run(async () => {
    const s = store.getState();
    if (!(await s.openInSidePane(r.sessionId, r.itemId, { focus: true }))) await s.openItem(r.itemId);
  });
  const stop = () => run(async () => {
    if (r.kind === "simulator") applySimulatorState((await rpc().call("simulators.stop", { simulatorId: r.refId })).state);
    else await store.getState().deleteItem(r.itemId);
  });
  const command = r.kind === "terminal" || r.kind === "build" || r.kind === "server";
  return (
    <li className="tm-resource" data-kind={r.kind}>
      <Icon name={RESOURCE_ICON[r.kind]} size={16} />
      <span className="tm-resource-label" data-command={command || undefined} title={r.label}>{r.label}</span>
      <span className="tm-resource-state">{r.state}</span>
      <span className="tm-resource-actions">
        <button type="button" className="btn btn-quiet tm-open" onClick={open}>Open</button>
        {r.live && (
          <button type="button" className="btn btn-quiet tm-halt" onClick={stop}
            title={r.kind === "simulator" ? "Stops streaming it; the simulator stays booted" : undefined}>Stop</button>
        )}
      </span>
    </li>
  );
}
