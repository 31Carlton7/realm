import { Icon, Realmite, parseRealmiteSpec } from "@realm/ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { TeamReviewSummary, TeamRole, TeamSpace } from "@realm/contracts";
import { Menu } from "../../../components/Menu";
import { useDissolve } from "../../../components/ScrollFades";
import { realmiteState } from "../../../components/sidebar/TeamRows";
import { useApp, type SubmitKey } from "../../../state/store";
import { duration, money, wakeSentence } from "../team-format";
import { RoleDrawer, RoleSheets } from "./RoleDrawer";
import { ThreadView } from "./ThreadView";
import { roleBlurb, roleKind } from "./chat-format";
import { assembleThread } from "./thread";

/** How many runs a chat reads back — the role's runs list's own page. */
const RUN_PAGE = 30;

/**
 * A teammate's chat: who it is and what it is doing at the head, the conversation under it, and the
 * prompter at the foot. Its details — brief, clock, budget, tools, records, Realmite — are a drawer at
 * the side, there when asked for and out of the way otherwise.
 */
export function TeamChat({ team, role, drawer, onDrawer }: { team: TeamSpace; role: TeamRole; drawer: boolean; onDrawer: (open: boolean) => void }) {
  const runs = useApp((s) => s.teamRoleRuns[role.id]);
  const activity = useApp((s) => s.teamRoleActivity[role.id]);
  const loadRoleRuns = useApp((s) => s.loadRoleRuns);
  const loadRoleActivity = useApp((s) => s.loadRoleActivity);
  const run = useApp((s) => s.run);
  const [replyTo, setReplyTo] = useState<TeamReviewSummary | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const now = useTick(role.state === "working" ? 15_000 : 60_000);
  useEffect(() => { run(() => Promise.all([loadRoleRuns(role.id), loadRoleActivity(role.id, role.spaceId)]).then(() => undefined)); }, [role.id, role.spaceId, loadRoleRuns, loadRoleActivity, run]);
  useMarkRead(role);

  const names = useMemo(() => new Map([...team.roles, ...team.formerRoles].map((r) => [r.id, r.name] as const)), [team.roles, team.formerRoles]);
  const items = useMemo(() => (runs && activity
    ? assembleThread({ role, runs, reviews: team.reviews, handoffs: team.handoffs, activity, names, runLimit: RUN_PAGE, now })
    : null), [role, runs, activity, team.reviews, team.handoffs, names, now]);

  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useDissolve(scroller);
  // A conversation opens on its newest message and follows the bottom while the reader is there.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, pending]);

  return (
    <div className="tc-chat" data-drawer={drawer || undefined}>
      <section className="tc-main" aria-label={`Chat with ${role.name}`}>
        <ChatHead role={role} team={team} drawer={drawer} onDrawer={onDrawer} now={now} />
        <div className="tc-scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
          <div className="tc-col">
            {items === null ? <p className="tp-empty tc-loading">Loading…</p>
              : items.length === 0 && !pending ? <EmptyThread role={role} />
              : <ThreadView items={items} role={role} team={team} now={now} onSendBack={setReplyTo} />}
            {pending && <div className="tc-row" data-side="you" data-start="" data-end="" data-pending=""><div className="tc-stack"><div className="tc-bubble">{pending}</div></div></div>}
          </div>
        </div>
        <ChatComposer role={role} replyTo={replyTo} onReplyDone={() => setReplyTo(null)}
          onSending={(text) => { atBottom.current = true; setPending(text); }} onSent={() => setPending(null)} />
      </section>
      <aside className="tc-drawer" aria-label={`${role.name}, in detail`} inert={!drawer || undefined}>
        {drawer && <RoleDrawer role={role} team={team} activity={activity ?? []} onClose={() => onDrawer(false)} />}
      </aside>
    </div>
  );
}

/** Re-render on a clock, so "Working · 4m" and "9:41 AM" keep up while the chat is open. */
function useTick(every: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

/** Reading the chat reads the run it finished last: its session's mark moves to its end. */
function useMarkRead(role: TeamRole) {
  const openSession = useApp((s) => s.openSession);
  const markSessionSeen = useApp((s) => s.markSessionSeen);
  const refreshTeam = useApp((s) => s.refreshTeam);
  const run = useApp((s) => s.run);
  const sessionId = role.unread ? role.latestSessionId : null;
  useEffect(() => {
    if (!sessionId) return;
    run(async () => { await openSession(sessionId); await markSessionSeen(sessionId); await refreshTeam(role.spaceId); });
  }, [sessionId, role.spaceId, openSession, markSessionSeen, refreshTeam, run]);
}

function ChatHead({ role, team, drawer, onDrawer, now }: { role: TeamRole; team: TeamSpace; drawer: boolean; onDrawer: (open: boolean) => void; now: number }) {
  const runRole = useApp((s) => s.runRole);
  const run = useApp((s) => s.run);
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const [sheet, setSheet] = useState<"edit" | "duplicate" | "remove" | null>(null);
  return (
    <header className="tc-head">
      <span className="tc-head-mite"><Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={32} state={realmiteState(role)} title={`${role.name}'s Realmite`} /></span>
      <div className="tc-head-text">
        <h1 className="tc-head-name">{role.name}</h1>
        <span className="tc-head-line">{headLine(role, now)}</span>
      </div>
      <button type="button" ref={more} className="icon-btn" aria-label={`More for ${role.name}`} title={`More for ${role.name}`} aria-haspopup="menu" aria-expanded={menu}
        onClick={() => setMenu((v) => !v)}><Icon name="more" size={16} /></button>
      {menu && (
        <Menu anchorRef={more} align="right" label={`More for ${role.name}`} onClose={() => setMenu(false)} items={[
          { label: "Run now", detail: "A run on its brief, with nothing said", onSelect: () => run(() => runRole(role.id, null).then(() => undefined)) },
          { kind: "separator" },
          { label: "Edit…", onSelect: () => setSheet("edit") },
          { label: "Duplicate…", detail: "A new teammate with this one's brief, model and clock", onSelect: () => setSheet("duplicate") },
          { kind: "separator" },
          { label: `Remove ${role.name} from the team…`, danger: true, onSelect: () => setSheet("remove") },
        ]} />
      )}
      <button type="button" className="icon-btn" aria-label={`${role.name}, in detail`} title="Details" aria-pressed={drawer}
        onClick={() => onDrawer(!drawer)}><Icon name="panelRight" size={16} /></button>
      <RoleSheets role={role} team={team} sheet={sheet} onClose={() => setSheet(null)} />
    </header>
  );
}

/** The head's second line: the starter it was made from, what it is doing, and when its clock next runs. */
export function headLine(role: TeamRole, now: number): string {
  const doing = role.state === "working" ? `Working · ${duration(now - (role.stateSince ?? now))}`
    : role.state === "waiting" ? "Needs you"
    : role.state === "queued" ? "Waiting for a free slot"
    : role.state === "paused" ? `Paused · ${role.pausedWhy ?? "its budget is spent"}`
    : null;
  const next = role.cron && role.scheduleEnabled && role.nextRunAt && role.nextRunAt > now ? `Next run ${nextWhen(role.nextRunAt, now)}` : null;
  const parts = [roleKind(role), doing, next ?? (doing ? null : role.cron ? wakeSentence(role.cron) : "Runs when you message it")];
  return parts.filter(Boolean).join(" · ");
}

function nextWhen(ts: number, now: number): string {
  const d = new Date(ts);
  const day = d.toDateString() === new Date(now).toDateString() ? "today" : d.toLocaleDateString(undefined, { weekday: "short" });
  return `${day} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/** A chat with nothing in it yet: who the teammate is, and what a message to it does. */
function EmptyThread({ role }: { role: TeamRole }) {
  return (
    <div className="tc-empty">
      <Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={160} state={realmiteState(role)} />
      <p className="tc-empty-name">{role.name}</p>
      <p className="tc-empty-line">{roleBlurb(role)}</p>
      <p className="tc-empty-hint">
        A message starts a run with your words and its brief{role.cron ? `. It also wakes ${lowerFirst(wakeSentence(role.cron))}` : ""}.
      </p>
    </div>
  );
}

/** A cadence in the middle of a sentence: its relative words lowered, a weekday's name left alone. */
const lowerFirst = (s: string) => s.replace(/^(Every|Weekdays|The) /, (w) => w.toLowerCase());

/**
 * The chat's prompter, made of the Agents tab's: the same card, field and send button. Return or ⌘↩
 * sends, as the session prompter's send-key setting says. "Send back" on a draft puts it in the
 * card's head, and what is sent then is the changes asked for that draft.
 */
function ChatComposer({ role, replyTo, onReplyDone, onSending, onSent }: {
  role: TeamRole; replyTo: TeamReviewSummary | null; onReplyDone: () => void; onSending: (text: string) => void; onSent: () => void;
}) {
  const messageRole = useApp((s) => s.messageRole);
  const requestChanges = useApp((s) => s.requestTeamReviewChanges);
  const submitKey = useApp((s) => s.submitKey);
  const run = useApp((s) => s.run);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (replyTo) field.current?.focus(); }, [replyTo]);
  const send = () => {
    const said = text.trim();
    if (!said || busy) return;
    setBusy(true); onSending(said); setText("");
    run(async () => {
      try {
        if (replyTo) { await requestChanges(replyTo.id, said); onReplyDone(); } else await messageRole(role.id, said);
      } catch (e) { setText(said); throw e; } finally { setBusy(false); onSent(); }
    });
  };
  const note = replyTo ? `${role.name} ${role.wakeOnReview ? "makes the changes in the run that sent it" : "does not wake on reviews, so this only marks it for changes"}.`
    : role.state === "working" ? `${role.name} is working. Your message goes when this run ends.`
    : role.state === "queued" ? `${role.name} is waiting for a free slot. Your message goes after it.`
    : null;
  return (
    <form className="tc-composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <div className="subagents-compose tc-compose-card">
        {replyTo && (
          <div className="tc-reply">
            <Icon name="undo" size={12} />
            <span className="tc-reply-text">Changes to “{replyTo.title}”</span>
            <button type="button" className="icon-btn tc-reply-x" aria-label="Not sending it back" title="Not sending it back (Esc)" onClick={onReplyDone}><Icon name="close" size={12} /></button>
          </div>
        )}
        <textarea ref={field} className="subagents-work tc-field" rows={1} value={text} spellCheck
          placeholder={replyTo ? "What should change?" : `Message ${role.name}…`}
          aria-label={replyTo ? `What should change in ${replyTo.title}` : `Message ${role.name}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && replyTo) { e.preventDefault(); e.stopPropagation(); onReplyDone(); return; }
            if (sendsOn(e, submitKey)) { e.preventDefault(); send(); }
          }} />
        <div className="subagents-compose-foot">
          <button type="submit" className="composer-send subagents-send" disabled={!text.trim() || busy}
            aria-label={replyTo ? "Send it back" : "Send"} title={`${replyTo ? "Send it back" : "Send"} (${submitKey === "enter" ? "↩" : "⌘↩"}). A run stops at ${money(role.runCapUsd)} or ${Math.round(role.runCapMs / 60_000)} minutes.`}>
            <Icon name="arrowUp" size={16} />
          </button>
        </div>
      </div>
      {note && <p className="tc-compose-note">{note}</p>}
    </form>
  );
}

/** The session prompter's rule: ⌘↩ always sends; a bare Return sends when the setting says Return,
 *  and is a new line otherwise; ⇧↩ is always a new line, and nothing sends mid-composition. */
export function sendsOn(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & { nativeEvent?: { isComposing?: boolean } }, submitKey: SubmitKey): boolean {
  if (e.key !== "Enter" || e.shiftKey || e.nativeEvent?.isComposing) return false;
  if (e.metaKey || e.ctrlKey) return true;
  return submitKey === "enter" && !e.altKey;
}

/**
 * A team with nobody on it — every teammate removed. The way back is the same picker the team was
 * made with.
 */
export function EmptyTeam({ spaceId }: { spaceId: string }) {
  const openSheet = useApp((s) => s.openSheet);
  return (
    <div className="tc-chat">
      <section className="tc-main" aria-label="Chats">
        <div className="tc-empty tc-empty-team">
          {/* off-ladder: the empty team's one picture, over the line that says who is missing — not a UI glyph. */}
          <Icon name="team" size={24} className="tc-empty-glyph" />
          <p className="tc-empty-name">No one is on this team</p>
          <p className="tc-empty-line">Add a teammate and its chat appears here. Each one works on its own clock and when you message it.</p>
          <button type="button" className="btn primary" onClick={() => openSheet({ kind: "add-teammates", spaceId })}><Icon name="add" size={16} />Add teammate</button>
        </div>
      </section>
    </div>
  );
}
