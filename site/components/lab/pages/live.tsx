import type { PageDesignProps } from "@/components/lab/pages"
import { Boundary } from "@/components/lab/page-live/chapters/Boundary"
import { Close } from "@/components/lab/page-live/chapters/Close"
import { Delegation } from "@/components/lab/page-live/chapters/Delegation"
import { Gateway } from "@/components/lab/page-live/chapters/Gateway"
import { Orbit } from "@/components/lab/page-live/chapters/Orbit"
import { Questions } from "@/components/lab/page-live/chapters/Questions"
import { SpaceLegend } from "@/components/lab/page-live/chapters/SpaceLegend"
import { Switchboard } from "@/components/lab/page-live/chapters/Switchboard"
import { TeamRelay } from "@/components/lab/page-live/chapters/TeamRelay"
import { Timeline } from "@/components/lab/page-live/chapters/Timeline"
import { WhereItLives } from "@/components/lab/page-live/chapters/WhereItLives"
import { Footer } from "@/components/lab/page-live/Footer"
import { Header } from "@/components/lab/page-live/Header"
import { Hero } from "@/components/lab/page-live/hero/Hero"
import { Chapter, Detail, Evidence } from "@/components/lab/page-live/kit/Chapter"
import { LiveStyles } from "@/components/lab/page-live/kit/LiveStyles"
import { delegation, facets, type Claim } from "@/content/home"
import { site } from "@/lib/site"
import track from "@/public/product/details/track.webp"

/**
 * Live: Realm as a live system.
 *
 * The hero is a map of a workspace drawn like a transit map — spaces as lines, sessions as stations,
 * agents travelling them — wired to the working sample of the app it leads into, so a request the map
 * shows arriving is the one the window lists, and answering it is what the map shows coming back.
 * Every chapter after it is an instrument the reader plays (scrubbed by scroll, or by the pointer and
 * keyboard), drawn in the same line language and labelled as a diagram or a sample, and followed by
 * the real capture that is its evidence.
 *
 *   hero        the map and the working sample
 *   spaces      the map's key: what a space holds; the real sidebar
 *   agents      a switchboard of the agents, into one unchanging workspace; the model picker
 *   delegation  a tree grown by scrolling, two levels and no further; the Agents tab
 *   transcript  a session's turns to scrub, Undo only where a checkpoint allows it; a real turn
 *   boundary    the sandbox's postures, and commands to try against them; the posture cards
 *   tools       a tool call as a sequence, the token never crossing; Connections and Code review
 *   durable     a week of schedules as an orbit, the window closable; Scheduled tasks
 *   teams       2.1's roles handing work along to Review
 *   local       what stays on the Mac, and the only lines that leave it
 *   questions, the one next action, and the footer
 */
export default function Live({ download, claims }: PageDesignProps) {
  const claim = (id: string) => claims.find((c) => c.id === id) as Claim

  return (
    <div className="min-h-[100dvh] overflow-x-clip">
      <LiveStyles />
      <Header href={download.href} />
      <main>
        <Hero download={download} />

        <SpaceLegend facets={facets} claim={claim("spaces")} />

        <Chapter id="agents" title="Bring the agent you already use." instrument={<Switchboard />} evidence={<Evidence claim={claim("agents")} />}>
          <p>
            Claude Code, Codex, Cursor, Gemini, OpenCode, GitHub Copilot, goose, Qwen Code and Grok all run here, most of
            them through one Agent Client Protocol adapter. Each keeps its own login, models and permission modes.
          </p>
          <p>
            The model picker groups models by the harness that runs them, with each model&rsquo;s effort levels and fast mode
            at its foot. <strong>Realm never asks for an API key.</strong> Signing in runs the agent&rsquo;s own login, and
            you&rsquo;re the one who approves it.
          </p>
        </Chapter>

        <Delegation beats={delegation} claim={claim("delegation")} />

        <Chapter
          id="transcript"
          title="A transcript you can read."
          flip
          instrument={<Timeline />}
          evidence={
            <div className="grid gap-10 lg:grid-cols-12 lg:items-end">
              <div className="lg:col-span-9">
                <Evidence claim={claim("transcript")} />
              </div>
              <Detail
                className="lg:col-span-3"
                src={track.src}
                width={track.width}
                height={track.height}
                alt="The card for a tick on a session's track: the prompt, how the answer began, the time, and Edited 2 files."
                caption="Hover a tick in the app and its card says what was asked, how the answer began, and what the turn edited."
              />
            </div>
          }
        >
          <p>
            A turn isn&rsquo;t a wall of log. Tool calls fold into rows you can open, a plan shows up as a plan, and a turn
            that changes files ends with a card listing each file and its line counts from git.
          </p>
          <p>
            Every prompt leaves a tick down the edge of the pane, so a long session has a map. Each turn is bracketed by a
            checkpoint. <strong>Undo is there only when a checkpoint can take back exactly that turn</strong>, and restoring
            one puts the files back. For Claude, it rewinds the conversation too.
          </p>
        </Chapter>

        <Chapter id="sandbox" title="Confine what an agent can touch." instrument={<Boundary />} evidence={<Evidence claim={claim("sandbox")} />}>
          <p>
            A space can run its agents and terminals inside a macOS Seatbelt policy. Its checkouts and toolchain caches stay
            writable, the files in your home that run things later can be read but not changed, and credential folders
            can&rsquo;t be read at all. The policy covers the process and everything it starts.
          </p>
          <p>
            Seatbelt isn&rsquo;t a container and the network stays open, so this limits what a session can damage or read,
            not what it can send. <strong>It&rsquo;s off by default, per space</strong>, because a list of writable folders
            that hasn&rsquo;t met your toolchain yet can break a build.
          </p>
        </Chapter>

        <Chapter
          id="tools"
          title="Your tools, without your credentials."
          flip
          instrument={<Gateway />}
          evidence={
            <div className="space-y-14">
              <Evidence claim={claim("gateway")} />
              <Evidence claim={claim("review")} />
            </div>
          }
        >
          <p>
            Linear, Notion, Slack, GitHub, Jira, Figma and Sentry connect in one click, and you sign in through the app. A
            connection belongs to the space, so every session in it reaches the tool through one Realm endpoint.{" "}
            <strong>The agent gets the tools and never the credential:</strong> it calls Realm, and Realm calls the server.
          </p>
          <p>
            Every call is logged with its arguments and what came back. OAuth connections are encrypted with a key kept in the
            macOS Keychain. A key you paste into a custom server isn&rsquo;t, and the app tells you so at that field.
          </p>
          <p>
            Code review works the same way. It lists your pull requests through your own gh, so Realm never holds a GitHub
            token, and nothing reaches GitHub until you press Submit review.
          </p>
        </Chapter>

        <Chapter id="durable" title="Work that outlives the window." instrument={<Orbit />} evidence={<Evidence claim={claim("durable")} />}>
          <p>
            realm-server keeps running after you close the window, so a long turn finishes whether you&rsquo;re watching or
            not.
          </p>
          <p>Tasks can run on a schedule, each on its own model, and every run is a real session you can read and pick up from.</p>
        </Chapter>

        <Chapter id="teams" title="A team in every space." flip instrument={<TeamRelay />}>
          <p className="flex items-center gap-2 text-[13px] text-accent-ink">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
            New in Realm 2.1
          </p>
          <p>
            Give a space roles that each work toward a goal, on their own schedule, and hand work along to one another. Every
            role wears a Realmite whose face is its run&rsquo;s state, never a mood.
          </p>
          <p>
            What the team makes waits in Review. <strong>Nothing is posted, sent or published until you approve it</strong>,
            and the space&rsquo;s policies bind every session in it, yours included. No agent can change a policy.
          </p>
        </Chapter>

        <Chapter id="local" title="Where the work lives." wide instrument={<WhereItLives />}>
          <p>
            On your Mac, under ~/Realm. Transcripts, documents, skills and checkpoints are files and a SQLite database on
            disk. Nothing is uploaded, and there&rsquo;s no account to make. Realm drives the agent CLIs you already have, on
            the plan you already pay for.
          </p>
        </Chapter>

        <Questions />
        <Close download={download} repo={site.repo} />
      </main>
      <Footer href={download.href} />
    </div>
  )
}
