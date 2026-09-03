import { SectionHeading } from "@/components/Section"

const features = [
  {
    title: "Split panes, properly",
    body: "Agents, terminals, browsers, simulators and artifacts share one pane system. Split, resize and group them; the layout is part of the space, so it is still there tomorrow.",
  },
  {
    title: "Sessions that survive a relaunch",
    body: "Transcripts are rebuilt from an event log rather than a cache. Quit mid-run, come back, and the next message resumes the provider session where it stopped.",
  },
  {
    title: "Credentials the agent never sees",
    body: "Configure an MCP server once per space. Sessions get a Realm endpoint instead of your token, and every proxied call is listed in the Activity view.",
  },
  {
    title: "Spaces per piece of work",
    body: "A profile holds spaces; a space holds its panes, its context and its MCP servers. Switching work is switching space, not rebuilding a window.",
  },
  {
    title: "Skills you can read",
    body: "Skills are plain folders on disk, laid out exactly like the library in ~/Realm/skills. Installing one is a copy; auditing one is a cat.",
  },
  {
    title: "Local by construction",
    body: "The renderer talks to a server on 127.0.0.1 and nothing else. Data lives in ~/Realm — point REALM_HOME somewhere else and the whole thing moves with it.",
  },
] as const

export function Features() {
  return (
    <section className="border-b border-line">
      <div className="mx-auto max-w-6xl px-6 py-24 lg:py-32">
        <SectionHeading
          eyebrow="What you get"
          title="Built for people who run several agents at once."
        />

        <div className="mt-14 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <article
              key={feature.title}
              className="group bg-page p-7 transition-colors duration-300 hover:bg-canvas"
            >
              <h3 className="text-[16px] font-medium text-ink">{feature.title}</h3>
              <p className="mt-3 text-[14.5px] leading-relaxed text-ink-2">{feature.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
