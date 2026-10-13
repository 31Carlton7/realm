/**
 * The state the hero's map and the working sample share, so they can never disagree: what each
 * session is doing, what has been answered, which session the window has open, and what the pointer
 * is on in either of them.
 *
 * It holds the sample's six sessions (content/mini-realm.ts) plus the two sub-agents the Dark mode
 * session started, because in the app a sub-agent is a session of its own: it asks for permission
 * like any other, in the mode its parent runs in, and its request sits in Needs you with the rest
 * ("Agent: Build the dark-mode toggle", as the sidebar capture shows it).
 *
 * Changes made here are instant, the way the app's are. The map animates what it draws between
 * states — a request travelling to Needs you, an answer coming back — but never holds a state the
 * window does not also show.
 */
import { sessions as SESSIONS } from "@/content/mini-realm"

export type Status = "working" | "waiting" | "done" | "scheduled"
export type SubAgent = "luna" | "fable"

export type SampleState = {
  status: Record<string, Status>
  answers: Record<string, string>
  /** The session the window has open. */
  selected: string
  /** The Needs you row whose card is unfolded in the sidebar. */
  expanded: string | null
  /** What the pointer is on, from the map or from the window: a space, a session, or nothing. */
  hover: { space: string | null; session: string | null }
  /** Bumped by a reset, so anything holding a timeline restarts from the top. */
  epoch: number
  /** The lead's own state of mind about its sub-agents, for its transcript. */
  reports: SubAgent[]
}

/** Everything the window lists in Needs you, as the app orders it: sessions first, then agents. */
export const NEEDS_ORDER = ["tests", "settings", "luna"] as const

/** The sub-agents' own sessions, as Needs you and the Agents tab name them. */
export const SUB_AGENTS: Record<SubAgent, { title: string; agent: "openai" | "claude"; model: string; harness: string; task: string; tool?: { name: string; command: string } }> = {
  luna: {
    title: "Build the dark-mode toggle",
    agent: "openai",
    model: "GPT-6 Luna",
    harness: "Codex",
    task: "Build the dark-mode toggle in Settings ▸ App, with its tests",
    tool: { name: "Bash", command: "pnpm test settings" },
  },
  fable: {
    title: "Write the migration that stores the theme",
    agent: "claude",
    model: "Fable 5.1",
    harness: "Claude",
    task: "Write the migration that stores the theme choice",
  },
}

/** Where the sample rests: every request in, nothing answered. Reduced motion starts here. */
export function restingState(epoch = 0): SampleState {
  return {
    status: { ...Object.fromEntries(SESSIONS.map((s) => [s.id, s.status])), luna: "waiting", fable: "done" },
    answers: {},
    selected: "crash",
    expanded: null,
    hover: { space: null, session: null },
    epoch,
    reports: ["fable"],
  }
}

/** Where a live hero starts: the lead has just handed out its two tasks and both sub-agents are at work. */
export function openingState(epoch = 0): SampleState {
  const rest = restingState(epoch)
  return { ...rest, status: { ...rest.status, luna: "working", fable: "working" }, reports: [] }
}

type Listener = () => void
export type SampleEvent =
  | { type: "answered"; id: string; value: string }
  /** A session has asked for something, and the request is on its way to Needs you. */
  | { type: "request"; id: string }
  /** The lead has handed its tasks out and its sub-agents are starting. */
  | { type: "delegated"; id: string }
  | { type: "reset" }

/** How long the things the map draws in transit take, so the window changes as they land. */
export const TRAVEL = { request: 1000, report: 900, answer: 700, delegate: 900, final: 1100 } as const

export type SampleStore = ReturnType<typeof createSampleStore>

export function createSampleStore(initial: SampleState) {
  let state = initial
  const listeners = new Set<Listener>()
  const eventListeners = new Set<(event: SampleEvent) => void>()
  const timers = new Set<number>()

  const set = (next: Partial<SampleState> | ((s: SampleState) => Partial<SampleState>)) => {
    const patch = typeof next === "function" ? next(state) : next
    state = { ...state, ...patch }
    for (const l of listeners) l()
  }
  const later = (ms: number, run: () => void) => {
    const epoch = state.epoch
    const t = window.setTimeout(() => {
      timers.delete(t)
      if (state.epoch === epoch) run()
    }, ms)
    timers.add(t)
  }
  const setStatus = (id: string, status: Status) => set((s) => ({ status: { ...s.status, [id]: status } }))
  const emit = (event: SampleEvent) => {
    for (const l of eventListeners) l(event)
  }

  /** A sub-agent has finished: its report travels to the lead, and once every report is in the lead
   *  reads them and answers, which is the whole of its turn. */
  const finishSubAgent = (agent: SubAgent) => {
    setStatus(agent, "done")
    later(TRAVEL.report, () => {
      store.report(agent)
      if (state.reports.length === Object.keys(SUB_AGENTS).length && state.status.dark === "working") {
        later(TRAVEL.final, () => setStatus("dark", "done"))
      }
    })
  }

  const store = {
    get: () => state,
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onEvent(listener: (event: SampleEvent) => void) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    select: (id: string) => set({ selected: id }),
    expand: (id: string | null) => set({ expanded: id }),
    toggleExpanded: (id: string) => set((s) => ({ expanded: s.expanded === id ? null : id })),
    hover: (space: string | null, session: string | null = null) => {
      if (state.hover.space === space && state.hover.session === session) return
      set({ hover: { space, session } })
    },
    setStatus,
    /** A sub-agent's report reaching its lead. When the last one is in, the lead writes its answer. */
    report(agent: SubAgent) {
      if (state.reports.includes(agent)) return
      set((s) => ({ reports: [...s.reports, agent] }))
    },
    /**
     * Answering, the one thing the sample acts out over time, as the app does it: the session works
     * for a moment and finishes, the way a short tool call does. Deny finishes it at once.
     */
    answer(id: string, value: string) {
      if (state.status[id] !== "waiting") return
      set((s) => ({ answers: { ...s.answers, [id]: value }, expanded: s.expanded === id ? null : s.expanded }))
      emit({ type: "answered", id, value })
      const subAgent = id in SUB_AGENTS ? (id as SubAgent) : null
      if (value === "Deny") {
        if (subAgent) finishSubAgent(subAgent)
        else setStatus(id, "done")
        return
      }
      setStatus(id, "working")
      later(1600, () => (subAgent ? finishSubAgent(subAgent) : setStatus(id, "done")))
    },
    /**
     * The opening of a live hero, from `openingState`: Dark mode's lead has just started its two
     * sub-agents. Fable finishes and reports; then Luna reaches its tests, which the session's mode
     * (Ask each time) says need your permission, and its request lands in Needs you beside the two
     * already there. From then on, nothing moves until the reader answers something.
     */
    play() {
      emit({ type: "delegated", id: "dark" })
      later(4300, () => finishSubAgent("fable"))
      later(6800, () => {
        emit({ type: "request", id: "luna" })
        later(TRAVEL.request, () => setStatus("luna", "waiting"))
      })
    },
    reset(next: SampleState) {
      for (const t of timers) window.clearTimeout(t)
      timers.clear()
      state = next
      for (const l of listeners) l()
      emit({ type: "reset" })
    },
    later,
    dispose() {
      for (const t of timers) window.clearTimeout(t)
      timers.clear()
      listeners.clear()
      eventListeners.clear()
    },
  }
  return store
}
