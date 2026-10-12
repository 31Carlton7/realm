"use client"

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react"

import { AgentMark } from "@/components/AgentMark"
import { Icon, type IconName } from "@/components/home/mini/icons"
import {
  chapter4,
  ORGS_FIRST_LINE,
  ORGS_NAMED_LINE,
  orgsTs,
  sessions as SESSIONS,
  spaces as SPACES,
  weeklyBars,
  type MiniSession,
  type PanelKind,
} from "@/content/mini-realm"

type View = "sidebar" | "session" | "panel"
type Status = MiniSession["status"]
type Note = { from: "you" | "realm"; text: string }

/** The views the control under the window jumps to. Each is a state the window can also be clicked
 *  into by hand; the control is a shortcut, never the only way there. */
const SCENES: { label: string; session: string; tab?: string; view: View; expand?: string }[] = [
  { label: "A session", session: "crash", tab: "crash-doc", view: "session" },
  { label: "Needs you", session: "settings", view: "sidebar", expand: "settings" },
  { label: "Sub-agents", session: "dark", tab: "dark-agents", view: "panel" },
  { label: "Terminal", session: "tests", tab: "tests-term", view: "panel" },
  { label: "Browser", session: "settings", tab: "settings-browser", view: "panel" },
]

const TAB_ICON: Record<PanelKind, IconName> = {
  document: "doc",
  terminal: "terminal",
  browser: "globe",
  agents: "agents",
  diff: "diff",
}

/**
 * A working sample of Realm, drawn in the page: the sidebar with every space and Needs you, a
 * session, and the side panel where what an agent opens shows up as a tab.
 *
 * Clerk's move, read for Realm: their hero is a sign-in you can actually use, and ours is the
 * workspace you can actually click. Pick a session, answer what is waiting from its row, follow the
 * answer's file link to the line it named, open a tab. It runs no agent and says so the moment you
 * type into it. The real captures stay further down the page as the evidence; this is the feel.
 *
 * Narrower than the whole window, it recomposes rather than shrinks (design.md, Accessibility): two
 * columns on a tablet, one on a phone, with the column chosen by what was last clicked.
 */
export function MiniRealm() {
  const [selected, setSelected] = useState("crash")
  const [view, setView] = useState<View>("session")
  const [tabs, setTabs] = useState<Record<string, string>>(() =>
    Object.fromEntries(SESSIONS.filter((s) => s.tabs.length).map((s) => [s.id, s.tabs[0]!.id])),
  )
  const [status, setStatus] = useState<Record<string, Status>>(() =>
    Object.fromEntries(SESSIONS.map((s) => [s.id, s.status])),
  )
  const [expanded, setExpanded] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, Note[]>>({})
  const [flash, setFlash] = useState(0)
  const [scene, setScene] = useState(0)
  const timers = useRef<number[]>([])

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])

  const session = SESSIONS.find((s) => s.id === selected)!
  const space = SPACES.find((s) => s.id === session.space)!
  const waiting = SESSIONS.filter((s) => status[s.id] === "waiting")
  const activeTab = session.tabs.find((t) => t.id === tabs[session.id]) ?? session.tabs[0]

  const select = (id: string, nextView: View = "session") => {
    setSelected(id)
    setView(nextView)
  }

  const openTab = (sessionId: string, tabId: string) => {
    setTabs((current) => ({ ...current, [sessionId]: tabId }))
    setView("panel")
  }

  /** Answering is the one thing the sample acts out over time: the session works for a moment and
   *  finishes, the way a short tool call does. A state change on a timer, not an animation. */
  const answer = (id: string, value: string) => {
    setAnswers((current) => ({ ...current, [id]: value }))
    setExpanded((current) => (current === id ? null : current))
    if (value === "Deny") {
      setStatus((current) => ({ ...current, [id]: "done" }))
      return
    }
    setStatus((current) => ({ ...current, [id]: "working" }))
    timers.current.push(
      window.setTimeout(() => setStatus((current) => ({ ...current, [id]: "done" })), 1600),
    )
  }

  const send = (text: string) => {
    setNotes((current) => ({
      ...current,
      [selected]: [
        ...(current[selected] ?? []),
        { from: "you", text },
        {
          from: "realm",
          text: `This window is a sample the page draws, so nothing ran. In Realm, this goes to ${session.model} in the ${space.name} checkout, and you can keep working while it does.`,
        },
      ],
    }))
  }

  const goToScene = (index: number) => {
    const s = SCENES[index]!
    setScene(index)
    setSelected(s.session)
    if (s.tab) setTabs((current) => ({ ...current, [s.session]: s.tab! }))
    setExpanded(s.expand && status[s.expand] === "waiting" ? s.expand : null)
    setView(s.view)
  }

  const openNamedLine = () => {
    openTab("crash", "crash-doc")
    setFlash((n) => n + 1)
  }

  return (
    <div className="flex h-full flex-col">
      <div
        role="region"
        aria-label="A working sample of Realm's window"
        data-view={view}
        className="group/win relative flex min-h-0 flex-1 overflow-hidden bg-page text-left text-[13px] leading-[1.45] text-ink-2 select-none"
      >
        <Rail />

        {/* The sidebar: Needs you over every space, the way the app has it since 2.0. */}
        <nav
          aria-label="Spaces"
          className="hidden w-full min-w-0 flex-col bg-canvas/60 group-data-[view=sidebar]/win:flex md:flex md:w-[248px] md:shrink-0 md:border-r md:border-line"
        >
          <div className="flex h-11 shrink-0 items-center gap-1.5 px-4 text-ink">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-raised text-[10px] font-[600] text-ink-2">C</span>
            <span className="text-[13px] font-[560]">Personal</span>
            <Icon name="chevronDown" className="h-3.5 w-3.5 text-ink-3" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [scrollbar-width:none]">
            {waiting.length ? (
              <>
                <p className="px-2 pt-1 pb-1 text-[12px] text-ink-3">Needs you</p>
                <ul>
                  {waiting.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        aria-expanded={expanded === s.id}
                        onClick={() => setExpanded((current) => (current === s.id ? null : s.id))}
                        className="flex h-8 w-full min-w-0 items-center gap-2 rounded-[8px] px-2 text-left text-ink transition-colors duration-150 hover:bg-raised"
                      >
                        <Icon name="chat" className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                        <span className="min-w-0 flex-1 truncate">{s.title}</span>
                        <span className="shrink-0 text-[11.5px] text-ink-3">{SPACES.find((x) => x.id === s.space)!.name}</span>
                        <Dot tone="orange" />
                      </button>
                      {expanded === s.id ? (
                        <div className="mx-1 mt-1 mb-2">
                          <WaitingCard session={s} onAnswer={(value) => answer(s.id, value)} compact />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <p className="flex items-center justify-between px-2 pt-3 pb-1 text-[12px] text-ink-3">Spaces</p>
            {SPACES.map((sp) => {
              const inSpace = SESSIONS.filter((s) => s.space === sp.id)
              const waits = inSpace.filter((s) => status[s.id] === "waiting").length
              const works = inSpace.filter((s) => status[s.id] === "working").length
              return (
                <div key={sp.id} className="mb-1">
                  <div className="flex h-8 items-center gap-2 px-2 text-ink">
                    <Icon name="chevronDown" className="h-3 w-3 text-ink-3" />
                    <span style={{ color: sp.color }}>
                      <Icon name={sp.icon} className="h-3.5 w-3.5" />
                    </span>
                    <span className="flex-1 font-[520]">{sp.name}</span>
                    {waits ? <Count n={waits} tone="orange" /> : null}
                    {works ? <Count n={works} tone="green" /> : null}
                  </div>
                  <ul>
                    {inSpace.map((s) => (
                      <li key={s.id}>
                        <button
                          type="button"
                          aria-current={selected === s.id ? "true" : undefined}
                          onClick={() => select(s.id)}
                          className="flex h-8 w-full min-w-0 items-center gap-2 rounded-[8px] pr-2 pl-[30px] text-left transition-colors duration-150 hover:bg-raised aria-[current=true]:bg-raised aria-[current=true]:text-ink"
                        >
                          {status[s.id] === "scheduled" ? <Icon name="clock" className="-ml-[18px] h-3 w-3 text-ink-3" /> : null}
                          <span className="min-w-0 flex-1 truncate">{s.title}</span>
                          <StatusDot status={status[s.id]!} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
          <div className="flex h-10 shrink-0 items-center gap-2 border-t border-line px-4 text-ink-3">
            <Icon name="plus" className="h-3.5 w-3.5" />
            New space
          </div>
        </nav>

        {/* The session. */}
        <section
          aria-label={`Session: ${session.title}`}
          className="hidden min-w-0 flex-1 flex-col group-data-[view=session]/win:flex md:group-data-[view=panel]/win:hidden md:group-data-[view=sidebar]/win:flex xl:!flex"
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 sm:px-4">
            <button
              type="button"
              onClick={() => setView("sidebar")}
              aria-label="Back to the sidebar"
              className="-ml-1 grid h-7 w-7 place-items-center rounded-[7px] text-ink-3 hover:bg-raised hover:text-ink md:hidden"
            >
              <Icon name="chevronLeft" className="h-4 w-4" />
            </button>
            <span style={{ color: space.color }}>
              <Icon name={space.icon} className="h-3.5 w-3.5" />
            </span>
            <span className="text-ink-2">{space.name}</span>
            <Icon name="chevronRight" className="h-3 w-3 shrink-0 text-ink-3" />
            <span className="min-w-0 truncate text-ink">{session.title}</span>
            <span className="ml-auto flex shrink-0 items-center gap-2 text-[12px] text-ink-3">
              <StatusDot status={status[session.id]!} />
              <span className="hidden sm:inline">{statusLabel(status[session.id]!)}</span>
            </span>
            {session.tabs.length ? (
              <button
                type="button"
                onClick={() => setView("panel")}
                aria-label="Open the side panel"
                className="grid h-7 w-7 place-items-center rounded-[7px] text-ink-3 hover:bg-raised hover:text-ink xl:hidden"
              >
                <Icon name="sidebar" className="h-4 w-4 -scale-x-100" />
              </button>
            ) : null}
          </div>

          <Transcript key={session.id}>
            <SessionBody
              session={session}
              status={status[session.id]!}
              answer={answers[session.id]}
              onAnswer={(value) => answer(session.id, value)}
              openNamedLine={openNamedLine}
              openTab={(tabId) => openTab(session.id, tabId)}
            />
            {(notes[session.id] ?? []).map((note, i) =>
              note.from === "you" ? (
                <p key={i} className="ml-auto max-w-[80%] rounded-[14px] bg-raised px-3.5 py-2 text-ink">
                  {note.text}
                </p>
              ) : (
                <p key={i} className="flex gap-2 text-ink-2">
                  <span className="mt-[3px] text-accent-ink">
                    <RealmGlyph />
                  </span>
                  <span>{note.text}</span>
                </p>
              ),
            )}
          </Transcript>

          <Prompter session={session} onSend={send} />
        </section>

        {/* The side panel: full height, one tab per thing an agent opened. */}
        <aside
          aria-label="Side panel"
          className="hidden min-w-0 flex-1 flex-col border-line bg-canvas/40 group-data-[view=panel]/win:flex xl:!flex xl:max-w-[400px] xl:border-l 2xl:max-w-[440px]"
        >
          <div
            role="tablist"
            aria-label="Side panel tabs"
            onKeyDown={(event) => {
              // Arrow keys move along the tabs, as a tab list should; Tab itself leaves the row.
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
              if (!step || !session.tabs.length) return
              event.preventDefault()
              const at = session.tabs.findIndex((t) => t.id === activeTab?.id)
              const next = session.tabs[(at + step + session.tabs.length) % session.tabs.length]!
              openTab(session.id, next.id)
              event.currentTarget.querySelector<HTMLElement>(`#mini-tab-${next.id}`)?.focus()
            }}
            className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-2"
          >
            <button
              type="button"
              onClick={() => setView("session")}
              aria-label="Back to the session"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-ink-3 hover:bg-raised hover:text-ink xl:hidden"
            >
              <Icon name="chevronLeft" className="h-4 w-4" />
            </button>
            {session.tabs.map((tab) => (
              <button
                key={tab.id}
                id={`mini-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={activeTab?.id === tab.id}
                tabIndex={(activeTab?.id ?? session.tabs[0]?.id) === tab.id ? 0 : -1}
                onClick={() => openTab(session.id, tab.id)}
                className="flex h-7 min-w-0 items-center gap-1.5 rounded-[8px] px-2.5 text-[12.5px] text-ink-3 transition-colors duration-150 hover:text-ink aria-selected:bg-raised aria-selected:text-ink"
              >
                <Icon name={TAB_ICON[tab.kind]} className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{tab.title}</span>
              </button>
            ))}
            <span className="ml-auto grid h-7 w-7 place-items-center text-ink-3">
              <Icon name="plus" className="h-3.5 w-3.5" />
            </span>
          </div>
          <div role="tabpanel" aria-labelledby={activeTab ? `mini-tab-${activeTab.id}` : undefined} className="min-h-0 flex-1 overflow-hidden">
            {activeTab ? (
              <PanelBody
                kind={activeTab.kind}
                session={session}
                status={status[session.id]!}
                answer={answers[session.id]}
                flash={flash}
              />
            ) : (
              <div className="grid h-full place-items-center p-8 text-center text-ink-3">
                <p className="max-w-[26ch]">Nothing open. What an agent opens shows up here, as a tab.</p>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Clerk's segmented row under its hero component, as the views worth seeing. */}
      <div className="flex justify-center border-t border-line bg-page px-2 py-2.5">
        <div role="group" aria-label="Show" className="flex max-w-full gap-1 overflow-x-auto [scrollbar-width:none]">
          {SCENES.map((s, i) => (
            <button
              key={s.label}
              type="button"
              aria-pressed={scene === i}
              onClick={() => goToScene(i)}
              className="app-corner flex h-8 shrink-0 items-center gap-2 rounded-[10px] px-3 text-[13px] text-ink-3 transition-colors duration-150 hover:text-ink aria-pressed:bg-raised aria-pressed:text-ink"
            >
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${scene === i ? "bg-accent" : "bg-ink-3/50"}`} />
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Rail() {
  const items: IconName[] = ["home", "book", "plug", "clock", "pr"]
  return (
    <div aria-hidden className="hidden w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-page py-3 text-ink-3 lg:flex">
      {items.map((name, i) => (
        <span key={name} className={`grid h-8 w-8 place-items-center rounded-[8px] ${i === 0 ? "bg-raised text-ink" : ""}`}>
          <Icon name={name} className="h-4 w-4" />
        </span>
      ))}
      <span className="mt-auto grid h-7 w-7 place-items-center rounded-full bg-raised text-[10px] font-[600] text-ink-2">C</span>
    </div>
  )
}

/** A transcript that keeps its newest line in view, as the app's does, without moving the page. */
function Transcript({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new MutationObserver(() => {
      node.scrollTop = node.scrollHeight
    })
    observer.observe(node, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  return (
    <div
      ref={ref}
      className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6 [mask-image:linear-gradient(to_bottom,transparent,black_18px,black_calc(100%-18px),transparent)] [scrollbar-width:none] sm:px-6"
    >
      <div className="mx-auto flex max-w-[620px] flex-col gap-3.5 text-[13.5px] leading-[1.6] text-ink">{children}</div>
    </div>
  )
}

function SessionBody({
  session,
  status,
  answer,
  onAnswer,
  openNamedLine,
  openTab,
}: {
  session: MiniSession
  status: Status
  answer?: string
  onAnswer: (value: string) => void
  openNamedLine: () => void
  openTab: (tabId: string) => void
}) {
  switch (session.id) {
    case "crash":
      return (
        <>
          <UserTurn>Please fix the org access crash. It only happens on staging.</UserTurn>
          <Worked>Worked for 2m 14s</Worked>
          <p>Fixed the org access crash path.</p>
          <p>
            The important change is in{" "}
            <FileLink onClick={openNamedLine}>web/lib/orgs.ts (line {ORGS_NAMED_LINE})</FileLink>:{" "}
            <Code>getOrgMembership()</Code> now selects only the stable fields access checks read. The invite metadata
            drifts between environments, and selecting it is what crashed staging.
          </p>
          <p className="text-ink-2">Verified:</p>
          <ul className="-mt-2 list-disc space-y-1 pl-5 marker:text-ink-3">
            <li>
              Reproduced with the org and user IDs from your error: <span className="text-green">passes</span>
            </li>
            <li>
              <Code>pnpm tsc --noEmit</Code>: <span className="text-green">passes</span>
            </li>
          </ul>
          <div className="rounded-[12px] bg-surface/80 p-3.5 shadow-[inset_0_0_0_1px_var(--color-line)]">
            <div className="flex items-center gap-2">
              <span className="font-[520]">Edited 2 files</span>
              <span className="font-mono text-[11.5px] text-green">+20</span>
              <span className="-ml-1 font-mono text-[11.5px] text-red">−3</span>
              <span className="ml-auto flex items-center gap-1 text-[12px] text-ink-3">
                Undo <Icon name="undo" className="h-3.5 w-3.5" />
              </span>
              <button
                type="button"
                onClick={() => openTab("crash-diff")}
                className="rounded-[8px] bg-raised px-2.5 py-1 text-[12px] text-ink transition-colors hover:bg-raised-2"
              >
                Review
              </button>
            </div>
            <div className="mt-2.5 space-y-1.5 text-[12.5px]">
              <EditedRow path="web/lib/" file="orgs.ts" plus={17} minus={2} />
              <EditedRow path="web/lib/agent/compaction/" file="auto-compact.ts" plus={3} minus={1} />
            </div>
          </div>
        </>
      )
    case "tests":
      return (
        <>
          <UserTurn>Write tests for the invite flow, and run them.</UserTurn>
          <p>I added twelve cases to web/lib/invites.test.ts: expired links, a second accept, an invite to an org you already belong to, and the role an invite grants.</p>
          <ToolRow icon="doc" label="Edited web/lib/invites.test.ts" detail="+148" />
          {status === "waiting" ? (
            <WaitingCard session={session} onAnswer={onAnswer} />
          ) : answer === "Deny" ? (
            <ToolRow icon="close" label="You denied pnpm vitest run" detail="Denied" tone="red" />
          ) : (
            <>
              <ToolRow icon="terminal" label="Ran pnpm vitest run web/lib/invites" detail={status === "working" ? "Running" : "12 passed"} tone={status === "working" ? undefined : "green"} />
              {status === "done" ? <p>All twelve pass. The terminal tab has the run, if you want to read it.</p> : null}
            </>
          )}
        </>
      )
    case "settings":
      return (
        <>
          <UserTurn>The settings page is one long column. Pick a better look, and show me before you build it.</UserTurn>
          <p>I sketched three layouts against the real settings in the dev server, which is open in the browser tab.</p>
          {status === "waiting" ? (
            <WaitingCard session={session} onAnswer={onAnswer} />
          ) : (
            <>
              <ToolRow icon="check" label={`You chose: ${answer}`} detail="Answered" tone="green" />
              <p>{status === "working" ? "Building it now." : `Done. The settings page uses ${answer?.toLowerCase()} now; it's live in the browser tab.`}</p>
            </>
          )}
        </>
      )
    case "dark":
      return (
        <>
          <UserTurn>
            Build dark mode with sub-agents: GPT-6 Luna on the toggle and its tests, Fable 5.1 on storing the choice, with a
            migration.
          </UserTurn>
          <p>I&rsquo;ll split this: the toggle and its tests go to GPT-6 Luna, and the migration to Fable.</p>
          <SubAgentRow state="waiting" title="Build the dark-mode toggle" agent="openai" model="GPT-6 Luna" time="34s" onOpen={() => openTab("dark-agents")} />
          <SubAgentRow state="done" title="Write the migration that stores the theme" agent="claude" model="Fable 5.1" time="8s" onOpen={() => openTab("dark-agents")} />
          <p className="text-ink-3">Waiting for 1 sub-agent…</p>
        </>
      )
    case "weekly":
      return (
        <>
          <p className="text-[12px] text-ink-3">Scheduled · every Monday at 9:00 AM</p>
          <p>Signups last week, by day. Thursday&rsquo;s launch post shows, and the weekend fell back to the usual.</p>
          <Bars />
          <p className="text-ink-2">354 signups, 18% over the week before.</p>
        </>
      )
    case "flash":
      return (
        <>
          <UserTurn>Turn chapter 4 into flashcards I can study tonight.</UserTurn>
          <p>
            Twelve cards from the chapter, saved as <FileLink onClick={() => openTab("flash-doc")}>chapter-4.md</FileLink>. I
            kept every formula the lecture wrote on the board.
          </p>
        </>
      )
    default:
      return null
  }
}

function PanelBody({ kind, session, status, answer, flash }: { kind: PanelKind; session: MiniSession; status: Status; answer?: string; flash: number }) {
  if (kind === "document" && session.id === "crash") return <CodeView flash={flash} />
  if (kind === "document") return <MarkdownView />
  if (kind === "diff") return <DiffView />
  if (kind === "terminal") return <TerminalView status={status} answer={answer} />
  if (kind === "browser") return <BrowserView status={status} answer={answer} />
  return <AgentsView />
}

/* ── Panel views ─────────────────────────────────────────────────────────────────────────────── */

const KEYWORDS = /\b(export|async|function|return|const|await|for|of|if|null|string)\b/

function highlight(line: string): ReactNode[] {
  const comment = line.indexOf("//") >= 0 ? line.indexOf("//") : line.indexOf("/**")
  const code = comment >= 0 ? line.slice(0, comment) : line
  const out: ReactNode[] = []
  code.split(/("[^"]*"|\b\w+\b)/).forEach((part, i) => {
    if (!part) return
    if (part.startsWith('"')) out.push(<span key={i} className="text-green">{part}</span>)
    else if (KEYWORDS.test(part) && /^\w+$/.test(part)) out.push(<span key={i} className="text-accent-ink">{part}</span>)
    else out.push(part)
  })
  if (comment >= 0) out.push(<span key="c" className="text-ink-3 italic">{line.slice(comment)}</span>)
  return out
}

function CodeView({ flash }: { flash: number }) {
  const ref = useRef<HTMLDivElement>(null)
  // Scroll the PANE to the named line, never the page: scrollIntoView would drag the whole site.
  useEffect(() => {
    const node = ref.current
    const target = node?.querySelector<HTMLElement>("[data-named]")
    if (!node || !target) return
    node.scrollTop = Math.max(0, target.offsetTop - node.clientHeight / 2)
  }, [flash])
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 px-4 text-[12px] text-ink-3">
        <span className="text-ink">orgs.ts</span> Saved
      </div>
      <div ref={ref} className="relative min-h-0 flex-1 overflow-auto pb-4 font-mono [font-variant-ligatures:none] text-[11.5px] leading-[1.75] [scrollbar-width:none]">
        {orgsTs.map((line, i) => {
          const n = ORGS_FIRST_LINE + i
          const named = n === ORGS_NAMED_LINE
          return (
            <div
              key={n}
              data-named={named || undefined}
              className={`flex pr-4 whitespace-pre ${named ? "bg-accent/12" : ""}`}
            >
              <span className={`w-11 shrink-0 pr-3 text-right select-none ${named ? "text-ink" : "text-ink-3/70"}`}>{n}</span>
              <span className="text-ink-2">{highlight(line)}</span>
            </div>
          )
        })}
        {flash > 0 ? (
          <span key={flash} aria-hidden className="mini-flash pointer-events-none absolute inset-x-0 h-[1.75em]" style={{ top: `${(ORGS_NAMED_LINE - ORGS_FIRST_LINE) * 1.75}em` }} />
        ) : null}
      </div>
    </div>
  )
}

function MarkdownView() {
  return (
    <div className="h-full overflow-auto px-5 py-4 text-[13px] leading-[1.65] [scrollbar-width:none]">
      {chapter4.map((line, i) =>
        line.startsWith("# ") ? (
          <p key={i} className="mb-2 text-[15px] font-[600] text-ink">
            {line.slice(2)}
          </p>
        ) : line.startsWith("**Q**") ? (
          <p key={i} className="text-ink">
            <span className="mr-1.5 font-mono text-[11px] text-accent-ink">Q</span>
            {line.slice(6)}
          </p>
        ) : line.startsWith("**A**") ? (
          <p key={i} className="text-ink-2">
            <span className="mr-1.5 font-mono text-[11px] text-green">A</span>
            {line.slice(6)}
          </p>
        ) : (
          <div key={i} className="h-2.5" />
        ),
      )}
    </div>
  )
}

function DiffView() {
  const rows: [" " | "+" | "-", string][] = [
    [" ", "export async function getOrgMembership(orgId, userId) {"],
    ["-", "  const rows = await db.select().from(organizationMember)"],
    ["+", "  // Only the stable columns access checks read."],
    ["+", "  const rows = await db"],
    ["+", "    .select({ id, organizationId, userId, role })"],
    ["+", "    .from(organizationMember)"],
    [" ", "    .where(and(eq(orgId), eq(userId)));"],
    ["+", "  for (const row of rows) withInviteDefaults(row);"],
    [" ", "  return rows[0] ?? null;"],
  ]
  return (
    <div className="h-full overflow-auto [scrollbar-width:none]">
      <div className="flex items-center gap-2 px-4 py-3 text-[12.5px]">
        <span className="text-ink-3">web/lib/</span>
        <span className="-ml-2 text-ink">orgs.ts</span>
        <span className="ml-auto font-mono text-[11.5px] text-green">+17</span>
        <span className="font-mono text-[11.5px] text-red">−2</span>
      </div>
      <div className="font-mono text-[11.5px] leading-[1.75]">
        {rows.map(([sign, text], i) => (
          <div
            key={i}
            className={`flex pr-4 whitespace-pre ${sign === "+" ? "bg-green/10 text-ink" : sign === "-" ? "bg-red/10 text-ink-2" : "text-ink-3"}`}
          >
            <span className={`w-8 shrink-0 text-center select-none ${sign === "+" ? "text-green" : sign === "-" ? "text-red" : ""}`}>{sign}</span>
            {text}
          </div>
        ))}
      </div>
      <p className="px-4 pt-4 text-[12.5px] leading-[1.55] text-ink-3">The turn&rsquo;s own diff, from git. Undo puts back exactly this turn, from its checkpoint.</p>
    </div>
  )
}

function TerminalView({ status, answer }: { status: Status; answer?: string }) {
  const ran = answer && answer !== "Deny"
  return (
    <div className="h-full overflow-auto bg-[oklch(0.18_0.004_264)] px-4 py-3 font-mono text-[11.5px] leading-[1.7] text-ink-2 [scrollbar-width:none]">
      <p>
        <span className="text-green">~/dashboard</span> <span className="text-accent-ink">main</span> ❯ git status --short
      </p>
      <p className="text-ink-3"> M web/lib/invites.test.ts</p>
      {ran ? (
        <>
          <p className="mt-2">
            <span className="text-green">~/dashboard</span> <span className="text-accent-ink">main</span> ❯ pnpm vitest run web/lib/invites
          </p>
          <p className="text-ink-3">RUN v3.2.4 ~/dashboard</p>
          {status === "done" ? (
            <>
              <p>
                <span className="text-green">✓</span> web/lib/invites.test.ts <span className="text-ink-3">(12 tests) 184ms</span>
              </p>
              <p className="mt-2">
                <span className="text-ink-3">Test Files</span> <span className="text-green">1 passed</span> (1)
              </p>
              <p>
                <span className="text-ink-3">     Tests</span> <span className="text-green">12 passed</span> (12)
              </p>
              <p className="mt-2">
                <span className="text-green">~/dashboard</span> <span className="text-accent-ink">main</span> ❯ <span className="mini-caret" />
              </p>
            </>
          ) : (
            <p className="text-ink-3">· web/lib/invites.test.ts 0/12</p>
          )}
        </>
      ) : (
        <p className="mt-2">
          <span className="text-green">~/dashboard</span> <span className="text-accent-ink">main</span> ❯ <span className="mini-caret" />
        </p>
      )}
      {!ran ? (
        <p className="mt-4 max-w-[34ch] font-sans text-[12px] leading-[1.55] text-ink-3">
          {answer === "Deny"
            ? "Denied, so nothing ran."
            : "The agent reads what this terminal shows. It runs nothing here until you allow it, in Needs you or in the session."}
        </p>
      ) : null}
    </div>
  )
}

function BrowserView({ status, answer }: { status: Status; answer?: string }) {
  const layout = status === "done" ? answer : undefined
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 px-2.5 text-ink-3">
        <Icon name="chevronLeft" className="h-3.5 w-3.5" />
        <Icon name="chevronRight" className="h-3.5 w-3.5" />
        <Icon name="reload" className="h-3.5 w-3.5" />
        <span className="ml-1 flex h-6 min-w-0 flex-1 items-center rounded-[7px] bg-raised px-2.5 text-[11.5px] text-ink-2">
          <span className="truncate">localhost:3000/settings</span>
        </span>
      </div>
      <div className="m-2.5 mt-0 min-h-0 flex-1 overflow-hidden rounded-[10px] bg-[oklch(0.97_0.003_264)] p-3 text-[oklch(0.3_0.01_264)]">
        <SettingsSketch layout={layout} working={status === "working"} />
      </div>
    </div>
  )
}

/** The dev server's settings page, drawn as blocks, in whichever layout the question settled. */
function SettingsSketch({ layout, working }: { layout?: string; working: boolean }) {
  const bar = (w: string, tone = "bg-[oklch(0.86_0.005_264)]") => <span className={`block h-2 rounded-full ${tone}`} style={{ width: w }} />
  const field = (key: number) => (
    <div key={key} className="flex items-center justify-between rounded-[6px] bg-white px-2.5 py-2 shadow-[0_0_0_1px_oklch(0_0_0/0.07)]">
      <div className="space-y-1.5">
        {bar("70px", "bg-[oklch(0.55_0.01_264)]")}
        {bar("110px")}
      </div>
      <span className="h-3.5 w-6 rounded-full bg-[oklch(0.62_0.18_256)]" />
    </div>
  )
  const title = <p className="mb-2 text-[12px] font-[600]">Settings</p>
  if (working) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-[oklch(0.5_0.01_264)]">Rebuilding the page…</div>
    )
  }
  if (layout === "Sections in a sidebar") {
    return (
      <div className="flex h-full gap-3">
        <div className="w-[34%] space-y-2 border-r border-[oklch(0_0_0/0.07)] pr-3 pt-6">
          {["Profile", "Notifications", "Billing", "Members"].map((s, i) => (
            <p key={s} className={`rounded-[5px] px-2 py-1 text-[11px] ${i === 0 ? "bg-[oklch(0.92_0.03_256)] text-[oklch(0.45_0.17_256)]" : ""}`}>
              {s}
            </p>
          ))}
        </div>
        <div className="flex-1 space-y-2">
          {title}
          {[0, 1, 2].map(field)}
        </div>
      </div>
    )
  }
  if (layout === "Tabs across the top") {
    return (
      <div className="space-y-2">
        {title}
        <div className="mb-3 flex gap-3 border-b border-[oklch(0_0_0/0.07)] text-[11px]">
          {["Profile", "Notifications", "Billing"].map((s, i) => (
            <span key={s} className={`pb-1.5 ${i === 0 ? "border-b-2 border-[oklch(0.62_0.18_256)] text-[oklch(0.45_0.17_256)]" : ""}`}>
              {s}
            </span>
          ))}
        </div>
        {[0, 1, 2].map(field)}
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {title}
      {[0, 1, 2, 3, 4].map(field)}
      {layout ? null : <p className="pt-1 text-[11px] text-[oklch(0.5_0.01_264)]">Today: one long column.</p>}
    </div>
  )
}

function AgentsView() {
  return (
    <div className="h-full space-y-2 overflow-auto p-3 [scrollbar-width:none]">
      <p className="px-1 pb-1 text-[12px] text-ink-3">Sub-agents · 2</p>
      <div className="rounded-[12px] bg-surface/80 p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
        <div className="flex items-center gap-2">
          <AgentMark id="openai" className="h-3.5 w-3.5 text-ink" />
          <span className="text-ink">GPT-6 Luna</span>
          <span className="text-ink-3">Codex</span>
          <span className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-2">
            <Dot tone="orange" /> Needs you
          </span>
        </div>
        <p className="mt-1.5 text-ink">Build the dark-mode toggle in Settings ▸ App, with its tests</p>
        <p className="mt-1 text-[12px] text-ink-3">Allow Bash: pnpm test settings</p>
      </div>
      <div className="rounded-[12px] bg-surface/80 p-3 shadow-[inset_0_0_0_1px_var(--color-line)]">
        <div className="flex items-center gap-2">
          <AgentMark id="claude" tinted className="h-3.5 w-3.5" />
          <span className="text-ink">Claude Fable 5.1</span>
          <span className="text-ink-3">Claude</span>
          <span className="ml-auto flex items-center gap-1 text-[12px] text-ink-3">
            <Icon name="check" className="h-3 w-3" /> Done 8s
          </span>
        </div>
        <p className="mt-1.5 text-ink">Write the migration that stores the theme choice</p>
        <p className="mt-1 text-[12px] leading-[1.5] text-ink-3">Wrote the migration and tested it against the previous schema. All twelve migration tests pass.</p>
      </div>
      <p className="px-1 pt-2 text-[12px] leading-[1.5] text-ink-3">Each sub-agent is a real session in the space, one click away. Two levels deep, and no further.</p>
    </div>
  )
}

/* ── Transcript parts ────────────────────────────────────────────────────────────────────────── */

function WaitingCard({ session, onAnswer, compact = false }: { session: MiniSession; onAnswer: (value: string) => void; compact?: boolean }) {
  const w = session.waiting!
  const button = `app-corner rounded-[9px] py-1.5 text-[12px] transition-[background-color,scale] duration-150 active:scale-[0.97] ${compact ? "px-2" : "px-2.5"}`
  return (
    <div className={`rounded-[12px] bg-surface p-3 shadow-[inset_0_0_0_1px_oklch(0.746_0.156_55.642/0.35)] ${compact ? "text-[12.5px]" : ""}`}>
      <div className="flex items-center gap-2 text-[12px] text-ink-3">
        <AgentMark id={session.agent} tinted className="h-3.5 w-3.5 text-ink" />
        <span>{session.model}</span>
        <span className="ml-auto flex items-center gap-1.5 text-orange">
          <Dot tone="orange" /> {w.kind === "permission" ? "Asks to run" : "Asks"}
        </span>
      </div>
      {w.kind === "permission" ? (
        <>
          <p className="mt-2 text-ink">Allow {w.tool}?</p>
          <p className="mt-1 overflow-x-auto rounded-[7px] bg-inset px-2 py-1.5 font-mono text-[11.5px] whitespace-nowrap text-ink-2 [scrollbar-width:none]">
            {w.command}
          </p>
          <div className="mt-2.5 flex gap-1">
            <button type="button" onClick={() => onAnswer("Allow")} className={`${button} bg-accent-fill text-white hover:bg-accent-fill-hover active:bg-accent-fill-press`}>
              Allow
            </button>
            <button type="button" onClick={() => onAnswer("Allow always")} className={`${button} bg-raised text-ink hover:bg-raised-2`}>
              Allow always
            </button>
            <button type="button" onClick={() => onAnswer("Deny")} className={`${button} text-ink-2 hover:bg-raised hover:text-ink`}>
              Deny
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-ink">{w.question}</p>
          <div className="mt-2.5 flex flex-col gap-1.5">
            {w.options.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onAnswer(option)}
                className="app-corner flex items-center justify-between rounded-[9px] bg-raised px-3 py-2 text-left text-[12.5px] text-ink transition-colors duration-150 hover:bg-raised-2"
              >
                {option}
                <Icon name="chevronRight" className="h-3.5 w-3.5 text-ink-3" />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function SubAgentRow({ state, title, agent, model, time, onOpen }: { state: "waiting" | "done"; title: string; agent: "openai" | "claude"; model: string; time: string; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="-mx-2 flex min-w-0 items-center gap-2.5 rounded-[8px] px-2 py-1 text-left transition-colors hover:bg-raised">
      {state === "waiting" ? <Dot tone="orange" /> : <Icon name="check" className="h-3 w-3 shrink-0 text-ink-3" />}
      <span className="shrink-0 text-ink">{state === "waiting" ? "Sub-agent waiting on you" : "Sub-agent finished"}</span>
      <span className="min-w-0 flex-1 truncate text-ink-3">· {title}</span>
      <AgentMark id={agent} tinted className="hidden h-3 w-3 shrink-0 text-ink-2 sm:block" />
      <span className="hidden shrink-0 text-[12px] text-ink-3 sm:inline">{model}</span>
      <span className="shrink-0 text-[12px] text-ink-3">{time}</span>
    </button>
  )
}

function Bars() {
  const max = Math.max(...weeklyBars.map((b) => b.value))
  return (
    <figure className="rounded-[12px] bg-surface/80 p-4 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <div className="flex h-28 items-end gap-2">
        {weeklyBars.map((b) => (
          <div key={b.label} className="flex h-full flex-1 flex-col justify-end gap-1.5">
            <span className="block rounded-[4px] bg-accent/85" style={{ height: `${(b.value / max) * 100}%` }} />
            <span className="text-center text-[11px] text-ink-3">{b.label}</span>
          </div>
        ))}
      </div>
      <figcaption className="sr-only">Signups by day: {weeklyBars.map((b) => `${b.label} ${b.value}`).join(", ")}</figcaption>
    </figure>
  )
}

function Prompter({ session, onSend }: { session: MiniSession; onSend: (text: string) => void }) {
  const [value, setValue] = useState("")
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = value.trim()
    if (!text) return
    onSend(text)
    setValue("")
  }
  const placeholder = useMemo(() => (session.status === "scheduled" ? "Ask about this run" : "Ask anything"), [session.status])
  return (
    <form onSubmit={submit} className="shrink-0 px-3 pb-3 sm:px-5 sm:pb-4">
      <div className="mx-auto max-w-[640px] rounded-[16px] bg-surface p-2.5 shadow-[inset_0_0_0_1px_var(--color-line-strong)] focus-within:shadow-[inset_0_0_0_1px_oklch(0.68_0.173_253.301/0.6)]">
        <label className="sr-only" htmlFor="mini-prompt">
          Message {session.model}
        </label>
        <input
          id="mini-prompt"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          className="w-full bg-transparent px-1.5 py-1 text-[16px] text-ink outline-none placeholder:text-ink-3 sm:text-[14px]"
        />
        <div className="mt-1.5 flex items-center gap-2 text-[12px] text-ink-3">
          <Icon name="plus" className="h-4 w-4" />
          <span className="hidden items-center gap-1 sm:flex">
            <Icon name="shield" className="h-3.5 w-3.5" /> Ask each time
          </span>
          <span className="ml-auto flex items-center gap-1.5 text-ink-2">
            <AgentMark id={session.agent} tinted className="h-3.5 w-3.5 text-ink" />
            {session.model} <span className="text-ink-3">High</span>
          </span>
          <button
            type="submit"
            aria-label="Send"
            className="grid h-7 w-7 place-items-center rounded-full bg-raised text-ink transition-[background-color,scale] duration-150 hover:bg-accent-fill hover:text-white active:scale-[0.94]"
          >
            <Icon name="arrowUp" className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </form>
  )
}

/* ── Small parts ─────────────────────────────────────────────────────────────────────────────── */

function UserTurn({ children }: { children: ReactNode }) {
  return <p className="ml-auto max-w-[85%] rounded-[14px] bg-raised px-3.5 py-2 text-ink">{children}</p>
}

function Worked({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1 text-[12.5px] text-ink-3">
      {children} <Icon name="chevronRight" className="h-3 w-3" />
    </p>
  )
}

function FileLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline text-accent-ink underline decoration-accent-ink/30 underline-offset-[3px] transition-colors hover:decoration-accent-ink">
      <Icon name="doc" className="mr-0.5 inline h-3.5 w-3.5 -translate-y-px" />
      {children}
    </button>
  )
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-[5px] bg-raised px-1 py-px font-mono text-[12px] text-ink">{children}</code>
}

function EditedRow({ path, file, plus, minus }: { path: string; file: string; plus: number; minus: number }) {
  return (
    <p className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-ink-3">
        {path}
        <span className="text-ink">{file}</span>
      </span>
      <span className="font-mono text-[11.5px] text-green">+{plus}</span>
      <span className="font-mono text-[11.5px] text-red">−{minus}</span>
    </p>
  )
}

function ToolRow({ icon, label, detail, tone }: { icon: IconName; label: string; detail: string; tone?: "green" | "red" }) {
  return (
    <p className="flex min-w-0 items-center gap-2 text-[13px] text-ink-2">
      <Icon name={icon} className="h-3.5 w-3.5 shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={`shrink-0 text-[12px] ${tone === "green" ? "text-green" : tone === "red" ? "text-red" : "text-ink-3"}`}>{detail}</span>
    </p>
  )
}

function Dot({ tone }: { tone: "orange" | "green" }) {
  return <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone === "orange" ? "bg-orange" : "bg-green"}`} />
}

function Count({ n, tone }: { n: number; tone: "orange" | "green" }) {
  return (
    <span className="flex items-center gap-1 text-[11.5px] text-ink-3">
      {n}
      <Dot tone={tone} />
    </span>
  )
}

function StatusDot({ status }: { status: Status }) {
  if (status === "waiting") return <Dot tone="orange" />
  if (status === "working") return <Dot tone="green" />
  return null
}

const statusLabel = (status: Status) =>
  status === "waiting" ? "Needs you" : status === "working" ? "Working" : status === "scheduled" ? "Scheduled" : "Done"

/** Realm's own one-colour mark, as the sample's voice. */
function RealmGlyph() {
  return (
    <svg viewBox="0 0 40 48" aria-hidden className="h-3.5 w-auto" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M0.5196 24.9A1.8 1.8 0 0 1 0.5196 23.1L9.4804 7.5795A1.8 1.8 0 0 1 11.0392 6.6795L28.9608 6.6795A1.8 1.8 0 0 1 30.5196 7.5795L39.4804 23.1A1.8 1.8 0 0 1 39.4804 24.9L30.5196 40.4205A1.8 1.8 0 0 1 28.9608 41.3205L11.0392 41.3205A1.8 1.8 0 0 1 9.4804 40.4205ZM24.4 20.8823L28.2 14.3005L35.9 27.6373L32.1 34.2191Z"
      />
    </svg>
  )
}
