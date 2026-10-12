import type { ReactNode } from "react"

import { AgentMark, ToolMark, type ToolId } from "@/components/AgentMark"
import { SpotlightGrid } from "@/components/home/SpotlightGrid"

/**
 * Everything a session can open, as one grid. Clerk's dark bento, read for Realm: each card is one
 * capability, said in a sentence, with a picture of exactly that. Where the app has been captured the
 * picture is the capture (the model picker, the question card); where the subject is a native view a
 * renderer screenshot cannot see — the browser pane, the device pane — it is drawn, in the app's own
 * tokens, and never dressed up as a capture.
 *
 * The section sits on a slab cut at the mark's angle, a shade under the page, so the cards read as
 * lit objects on a floor rather than boxes on a background.
 */
export function Bento() {
  return (
    <section aria-labelledby="bento-title" className="relative px-3 py-8 sm:px-6">
      <div className="slab mx-auto max-w-[96rem] bg-[oklch(0.185_0.004_264)] px-3 pt-24 pb-20 sm:px-8 sm:pt-32 sm:pb-28">
        <div className="mx-auto max-w-[84rem]">
          <div className="max-w-[40rem] px-3 sm:px-2">
            <h2 id="bento-title" className="text-[clamp(2rem,4vw,3.25rem)] leading-[1.02] font-[580] tracking-[-0.045em] text-balance text-ink">
              Everything the work needs, beside it.
            </h2>
            <p className="mt-5 max-w-[50ch] text-[17px] leading-[1.55] text-ink-2">
              What an agent opens shows up as a tab in the side panel, next to the session that opened it: a
              terminal, a browser, a device, a document. You see what it sees.
            </p>
          </div>

          <SpotlightGrid className="mt-14 grid gap-3 sm:mt-16 md:grid-cols-2 lg:grid-cols-3">
            <Card
              className="lg:col-span-2"
              title="Terminals the agent can read."
              body="Real terminals next to the agent. It reads what a terminal is showing on screen, not a raw log, and can answer a prompt that's waiting in one."
            >
              <TerminalArt />
            </Card>

            <Card
              grow
              className="md:row-span-2"
              title="Every model, one picker."
              body="Grouped by the harness that runs each one, with what it's good for, its context and its price, and effort and fast mode at the bottom."
            >
              <div className="flex h-full flex-col justify-center">
                <Crop
                  src="/product/details/model-picker.webp"
                  alt="The model picker: Claude's models, then Codex's, Opus 5.5 picked, its description, and the effort track at Max with fast mode on."
                  source={[1236, 1680]}
                  box={[58, 153, 1178, 1663]}
                  className="mx-auto w-full max-w-[380px]"
                />
              </div>
            </Card>

            <Card
              title="A browser that stays signed in."
              body="Agents can read and drive it. It stops at a consent screen: approving a sign-in is your click, unless the space says otherwise."
            >
              <BrowserArt />
            </Card>

            <Card
              title="Simulators, and your iPhone."
              body="Agents can open a device, install, launch, tap, swipe and type, on iOS simulators, Android emulators, and an iPhone over the cable."
            >
              <DeviceArt />
            </Card>

            <Card
              className="lg:col-span-2"
              title="Every agent's questions on one card."
              body="A question looks the same whichever agent or server asks it, and says who's asking first. Answer it in the session or straight from Needs you."
            >
              {/* On a phone the card keeps a readable size and runs off the card's edge rather than
                  shrinking to fit it. */}
              <div className="-mr-6 overflow-hidden sm:mr-0">
                <Crop
                  src="/product/details/question-card.webp"
                  alt="Claude asks which look the settings page should take, with three pictured options: Calm, Bold and Dense."
                  source={[2280, 1080]}
                  box={[56, 58, 2224, 1022]}
                  className="w-[520px] sm:w-full"
                />
              </div>
            </Card>

            <Card
              title="Your tools, never your credentials."
              body="Connections belong to the space. The agent calls Realm, Realm calls the server, and every call is logged with what came back."
            >
              <ToolsArt />
            </Card>

            <Card
              title="A boundary, when you want one."
              body="A space can run its agents inside a macOS sandbox. Off by default, because a sandbox that hasn't met your toolchain can break a build."
            >
              <SandboxArt />
            </Card>

            <Card title="Memory every session reads." body="A space keeps notes its sessions read before they start, and Memory saves what's worth keeping as it goes.">
              <MemoryArt />
            </Card>

            <Card
              title="Work on a schedule."
              body="Tasks run on their own model at the times you set, and every run is a real session you can read and pick up from."
            >
              <ScheduleArt />
            </Card>
          </SpotlightGrid>
        </div>
      </div>
    </section>
  )
}

function Card({ title, body, children, className, grow = false }: { title: string; body: string; children: ReactNode; className?: string; grow?: boolean }) {
  return (
    <article data-spot className={`spot flex min-w-0 flex-col gap-6 p-6 sm:p-7 ${className ?? ""}`}>
      <div className="max-w-[46ch]">
        <h3 className="text-[15.5px] leading-[1.35] font-[560] tracking-[-0.01em] text-ink">{title}</h3>
        <p className="mt-2 text-[14.5px] leading-[1.55] text-ink-2">{body}</p>
      </div>
      <div className={`min-w-0 ${grow ? "relative flex-1" : "mt-auto"}`}>
        {children}
      </div>
    </article>
  )
}

/**
 * A capture cut to the component it shows. The detail captures carry a margin of the window around
 * the card, which read as a second, mismatched box on the bento's own surface; this shows only the
 * card, by its own outline. `box` is [left, top, right, bottom] in the source's pixels.
 */
function Crop({
  src,
  alt,
  source: [sw, sh],
  box: [x0, y0, x1, y1],
  className,
}: {
  src: string
  alt: string
  source: [number, number]
  box: [number, number, number, number]
  className?: string
}) {
  const w = x1 - x0
  const h = y1 - y0
  return (
    <div
      style={{ aspectRatio: `${w} / ${h}` }}
      className={`relative overflow-hidden rounded-[16px] shadow-[0_0_0_1px_var(--color-line),0_24px_48px_-24px_oklch(0_0_0/0.6)] ${className ?? ""}`}
    >
      <img
        src={src}
        alt={alt}
        width={sw / 3}
        height={sh / 3}
        loading="lazy"
        decoding="async"
        style={{ width: `${(sw / w) * 100}%`, left: `${(-x0 / w) * 100}%`, top: `${(-y0 / h) * 100}%` }}
        className="absolute h-auto max-w-none"
      />
    </div>
  )
}

/* ── The drawn pictures. One stroke weight, the app's surfaces, its status colours and nothing else. ── */

const panel = "rounded-[14px] bg-page shadow-[inset_0_0_0_1px_var(--color-line)]"

function TerminalArt() {
  return (
    <div aria-hidden className={`${panel} overflow-hidden font-mono text-[12px] leading-[1.75]`}>
      <div className="flex h-8 items-center gap-2 border-b border-line px-3.5 font-sans text-[12px] text-ink-3">
        <span className="h-2 w-2 rounded-full bg-ink-3/40" />
        zsh · dashboard
      </div>
      <div className="px-4 py-3 text-ink-2">
        <p>
          <span className="text-green">~/dashboard</span> ❯ pnpm db:migrate --env staging
        </p>
        <p className="text-ink-3">2 migrations pending: 0041_invites, 0042_roles</p>
        <p className="relative -mx-2 mt-1 rounded-[7px] px-2 py-0.5 text-ink shadow-[inset_0_0_0_1px_oklch(0.68_0.173_253.301/0.7)] [background:oklch(0.68_0.173_253.301/0.1)]">
          ? Apply them to staging? (y/N) <span className="mini-caret" />
          <span className="absolute -top-2.5 right-2 rounded-[5px] bg-accent-fill px-1.5 font-sans text-[10.5px] leading-[1.5] text-white">
            on screen
          </span>
        </p>
      </div>
      <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5 font-sans text-[12.5px] text-ink-2">
        <AgentMark id="claude" tinted className="h-3.5 w-3.5" />
        <span className="min-w-0 sm:truncate">It&rsquo;s asking about staging, not local. I&rsquo;ll answer no and ask you first.</span>
      </div>
    </div>
  )
}

function BrowserArt() {
  return (
    <div aria-hidden className={`${panel} overflow-hidden`}>
      <div className="flex h-8 items-center gap-2 px-3 text-[11.5px] text-ink-3">
        <span className="flex h-5 flex-1 items-center rounded-[6px] bg-raised px-2 text-ink-2">linear.app/oauth/authorize</span>
      </div>
      <div className="m-2 mt-0 rounded-[10px] bg-[oklch(0.97_0.003_264)] px-4 py-4 text-center text-[oklch(0.3_0.01_264)]">
        <ToolMark id="linear" tinted className="mx-auto h-6 w-6" />
        <p className="mt-2 text-[12.5px] font-[560]">Allow access to your workspace?</p>
        <div className="mt-3 flex justify-center gap-2 text-[11.5px]">
          <span className="rounded-[7px] px-2.5 py-1 shadow-[inset_0_0_0_1px_oklch(0_0_0/0.12)]">Cancel</span>
          <span className="relative rounded-[7px] bg-[oklch(0.55_0.17_275)] px-2.5 py-1 text-white outline-2 outline-offset-2 outline-orange outline-dashed">
            Approve
          </span>
        </div>
      </div>
      <p className="flex items-center gap-1.5 px-3.5 pb-3 text-[12px] text-ink-2">
        <span className="h-1.5 w-1.5 rounded-full bg-orange" /> The agent stopped here. This one is yours.
      </p>
    </div>
  )
}

function DeviceArt() {
  return (
    <div aria-hidden className="flex items-end justify-center gap-4">
      <div className="relative h-[176px] w-[96px] rounded-[20px] bg-page p-1.5 shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
        <div className="mx-auto mb-2 h-1.5 w-8 rounded-full bg-raised" />
        <div className="space-y-1.5 px-1.5">
          <span className="block h-2 w-14 rounded-full bg-ink-3/40" />
          <span className="block h-6 rounded-[6px] bg-raised" />
          <span className="block h-6 rounded-[6px] bg-raised" />
          <span className="relative mt-5 block h-6 rounded-[7px] bg-accent">
            <span className="absolute top-1/2 left-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_0_1.5px_oklch(1_0_0/0.85)]" />
          </span>
        </div>
      </div>
      <div className="mb-3 space-y-1.5 font-mono text-[11.5px] text-ink-2">
        <p>simulator_launch</p>
        <p>simulator_type &ldquo;ada@&hellip;&rdquo;</p>
        <p className="text-ink">simulator_tap &ldquo;Continue&rdquo;</p>
      </div>
    </div>
  )
}

function ToolsArt() {
  const node = "grid h-10 w-10 place-items-center rounded-[11px] bg-page shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
  const rule = "h-px flex-1 bg-[linear-gradient(to_right,var(--color-line-strong)_50%,transparent_50%)] bg-[length:6px_1px]"
  /* The log is the claim's second half: every call, and what came back. */
  const calls: { tool: ToolId; call: string; result: string; tone: string }[] = [
    { tool: "linear", call: "create_issue", result: "INV-212 created", tone: "text-ink-2" },
    { tool: "github", call: "get_pull_request", result: "#481 · 3 files", tone: "text-ink-2" },
    { tool: "notion", call: "search", result: "4 pages", tone: "text-ink-2" },
    { tool: "linear", call: "update_issue", result: "INV-208 · In review", tone: "text-ink-2" },
    { tool: "github", call: "create_review", result: "2 comments", tone: "text-ink-2" },
    { tool: "slack", call: "post_message", result: "Waiting on you", tone: "text-orange" },
  ]
  return (
    <div aria-hidden className="space-y-5">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex flex-col items-center gap-1.5 text-[11.5px] text-ink-3">
          <span className={node}>
            <AgentMark id="openai" className="h-4.5 w-4.5 text-ink-2" />
          </span>
          Agent
        </div>
        <span className={rule} />
        <div className="flex flex-col items-center gap-1.5 text-[11.5px] text-ink-3">
          <span className={`${node} text-accent-ink shadow-[inset_0_0_0_1px_oklch(0.68_0.173_253.301/0.6)]`}>
            <svg viewBox="0 0 16 16" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round">
              <circle cx="5.5" cy="8" r="2.5" />
              <path d="M8 8h6m-2 0v2.5" />
            </svg>
          </span>
          Realm
        </div>
        <span className={rule} />
        <div className="grid grid-cols-2 gap-1.5">
          {(["linear", "github", "slack", "notion"] as const).map((id) => (
            <span key={id} className="grid h-8 w-8 place-items-center rounded-[9px] bg-page text-ink-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
              <ToolMark id={id} className="h-3.5 w-3.5" />
            </span>
          ))}
        </div>
      </div>
      <div className={`${panel} divide-y divide-line`}>
        {calls.map(({ tool, call, result, tone }) => (
          <p key={call} className="flex items-center gap-2.5 px-3.5 py-2.5 text-[12px]">
            <ToolMark id={tool} className="h-3.5 w-3.5 shrink-0 text-ink-3" />
            <span className="min-w-0 truncate font-mono text-[11.5px] text-ink">{call}</span>
            <span className={`ml-auto shrink-0 ${tone}`}>{result}</span>
          </p>
        ))}
      </div>
    </div>
  )
}

function SandboxArt() {
  const rows: [string, string, string][] = [
    ["~/code/dashboard", "Writable", "text-green"],
    ["~/.zshrc", "Read only", "text-ink-2"],
    ["~/.ssh", "No access", "text-red"],
  ]
  return (
    <div aria-hidden className={`${panel} divide-y divide-line`}>
      {rows.map(([path, rule, tone]) => (
        <p key={path} className="flex items-center justify-between px-3.5 py-2.5 text-[12.5px]">
          <span className="font-mono text-[11.5px] text-ink">{path}</span>
          <span className={tone}>{rule}</span>
        </p>
      ))}
    </div>
  )
}

function MemoryArt() {
  return (
    <div aria-hidden className={`${panel} px-4 py-3 font-mono text-[11.5px] leading-[1.8] text-ink-2`}>
      <p className="text-ink-3"># Dashboard</p>
      <p>- Use pnpm. The lockfile is pnpm&rsquo;s.</p>
      <p>- Staging&rsquo;s database is read-only.</p>
      <p className="text-ink">
        - Invites expire after 7 days. <span className="font-sans text-[11px] text-accent-ink">saved today</span>
      </p>
    </div>
  )
}

function ScheduleArt() {
  return (
    <div aria-hidden className={`${panel} px-4 py-3`}>
      <div className="flex items-center gap-2 text-[12.5px]">
        <AgentMark id="claude" tinted className="h-3.5 w-3.5" />
        <span className="text-ink">Weekly numbers</span>
        <span className="ml-auto text-ink-3">Mon 9:00 AM</span>
      </div>
      <div className="mt-3 space-y-1.5 text-[12px]">
        {[
          ["Oct 12", "354 signups, 18% up", true],
          ["Oct 5", "300 signups", false],
          ["Sep 28", "287 signups", false],
        ].map(([date, line, fresh]) => (
          <p key={String(date)} className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${fresh ? "bg-accent" : "bg-transparent"}`} />
            <span className="w-12 text-ink-3">{date}</span>
            <span className={fresh ? "text-ink" : "text-ink-2"}>{line}</span>
          </p>
        ))}
      </div>
    </div>
  )
}
