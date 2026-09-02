import { SectionHeading } from "@/components/Section"

/**
 * A drawing of the app, not a screenshot — pure CSS, so it stays sharp on any display, weighs
 * nothing, and never goes stale against a build. It shows the one thing the copy claims: a space,
 * split into panes, each pane running something different.
 */
export function AppMock() {
  return (
    <section id="product" className="relative border-b border-line">
      <div className="mx-auto max-w-6xl px-6 py-24 lg:py-32">
        <SectionHeading
          eyebrow="The workspace"
          title="One window. Every agent."
          lede="A space holds your panes. Put a Claude session next to the terminal it is driving, next to the browser it is testing, next to the diff it produced — and keep all of it in view."
        />

        <div className="relative mt-14">
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-8 -top-8 bottom-0 bg-[radial-gradient(700px_360px_at_50%_0%,color-mix(in_srgb,var(--color-accent)_12%,transparent),transparent_72%)]"
          />
          <div className="relative overflow-hidden rounded-xl border border-line bg-canvas shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset,0_30px_80px_-20px_rgba(0,0,0,0.8)]">
            {/* title bar */}
            <div className="flex h-10 items-center gap-2 border-b border-line bg-surface/60 px-4">
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
              <span className="ml-3 font-mono text-[11px] text-ink-3">realm — payments</span>
            </div>

            <div className="flex min-h-[420px]">
              <Sidebar />
              <div className="grid flex-1 grid-cols-1 sm:grid-cols-2">
                <AgentPane />
                <div className="grid grid-rows-2 border-t border-line sm:border-t-0 sm:border-l">
                  <TerminalPane />
                  <ArtifactPane />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function Sidebar() {
  const spaces = [
    { name: "payments", color: "#7c6cff", active: true },
    { name: "infra", color: "#3fb27f" },
    { name: "docs-site", color: "#e5a44a" },
  ]
  const sessions = ["Refactor the webhook dispatcher", "Trace the 502 on checkout", "Bump the Stripe SDK"]

  return (
    <aside className="hidden w-52 shrink-0 border-r border-line bg-page/40 p-3 md:block">
      <p className="px-2 text-[10px] font-medium tracking-[0.1em] text-ink-3 uppercase">Spaces</p>
      <ul className="mt-2 space-y-0.5">
        {spaces.map((space) => (
          <li key={space.name}>
            <span
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] ${
                space.active ? "bg-white/6 text-ink" : "text-ink-3"
              }`}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: space.color }} />
              {space.name}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-6 px-2 text-[10px] font-medium tracking-[0.1em] text-ink-3 uppercase">Sessions</p>
      <ul className="mt-2 space-y-0.5">
        {sessions.map((label, i) => (
          <li key={label}>
            <span
              className={`block truncate rounded-md px-2 py-1.5 text-[12px] ${
                i === 0 ? "bg-white/6 text-ink" : "text-ink-3"
              }`}
            >
              {label}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  )
}

function PaneChrome({ label, badge, children }: { label: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="font-mono text-[10.5px] text-ink-3">{label}</span>
        {badge ? (
          <span className="rounded-full bg-accent/15 px-1.5 py-px font-mono text-[9.5px] text-accent-ink">
            {badge}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-3">{children}</div>
    </div>
  )
}

function AgentPane() {
  return (
    <PaneChrome label="claude · session" badge="running">
      <div className="space-y-3 text-[12px] leading-relaxed">
        <p className="text-ink-2">
          <span className="mr-2 font-mono text-[10px] text-ink-3">you</span>
          The webhook dispatcher drops retries under load. Find out why.
        </p>
        <div className="space-y-2 text-ink-3">
          <p>
            Reading <span className="font-mono text-accent-ink">src/webhooks/dispatch.ts</span> …
          </p>
          <p>
            The retry queue is bounded at 64 and drops silently when full. Three call sites enqueue
            without checking the return value.
          </p>
        </div>
        <div className="rounded-lg border border-line bg-page/60 p-2.5">
          <p className="font-mono text-[10px] text-ink-3">Edit · dispatch.ts</p>
          <pre className="mt-1.5 overflow-hidden font-mono text-[10.5px] leading-[1.6]">
            <code>
              <span className="text-[#f0776c]">- queue.push(job)</span>
              {"\n"}
              <span className="text-[#7ee787]">+ if (!queue.push(job)) await queue.drain()</span>
            </code>
          </pre>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          <span className="font-mono text-[10px] text-ink-3">running tests…</span>
        </div>
      </div>
    </PaneChrome>
  )
}

function TerminalPane() {
  return (
    <PaneChrome label="zsh">
      <pre className="overflow-hidden font-mono text-[10.5px] leading-[1.75] text-ink-3">
        <code>
          <span className="text-accent-ink">~/work/payments</span> ❯ pnpm test webhooks{"\n"}
          {"\n"}✓ dispatch › retries under backpressure{"\n"}✓ dispatch › drains a full queue{"\n"}✓
          dispatch › surfaces a rejected push{"\n"}
          {"\n"}
          <span className="text-[#7ee787]"> 3 passed</span> (1.4s)
        </code>
      </pre>
    </PaneChrome>
  )
}

function ArtifactPane() {
  return (
    <div className="flex min-w-0 flex-col border-t border-line">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="font-mono text-[10.5px] text-ink-3">mcp · activity</span>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 p-3">
        {[
          { tool: "linear.get_issue", ok: true },
          { tool: "github.create_pr", ok: true },
          { tool: "sentry.list_events", ok: true },
        ].map((row) => (
          <div key={row.tool} className="flex items-center justify-between font-mono text-[10.5px]">
            <span className="text-ink-3">{row.tool}</span>
            <span className="text-[#7ee787]">200</span>
          </div>
        ))}
        <p className="pt-2 text-[10.5px] leading-relaxed text-ink-3">
          Proxied through the gateway. The agent never saw a token.
        </p>
      </div>
    </div>
  )
}
