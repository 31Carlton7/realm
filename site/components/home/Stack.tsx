import { SectionHeading } from "@/components/Section"

const layers = [
  {
    title: "Agent adapters",
    body: "Claude sessions run on the claude-agent-sdk, driving the CLI you are already logged into. A scripted Fake agent covers offline and UI work. Every adapter produces the same transcript shape, so the app never learns a second vocabulary.",
  },
  {
    title: "Panes & layout",
    body: "Sessions, terminals, browsers, simulators and artifacts are all panes, split and resized the same way. Layout changes are typed operations against a shared contract rather than ad-hoc component state.",
  },
  {
    title: "Context pool",
    body: "The files, notes and references a space works from, in one place every session in that space can draw on — so you brief the space once instead of briefing each agent.",
  },
  {
    title: "MCP gateway",
    body: "Third-party MCP servers are configured per space, not per agent. Every session gets one Realm endpoint, credentials and OAuth tokens stop at the gateway, and every proxied tool call lands in the Activity view.",
  },
  {
    title: "realm-server",
    body: "A local server that owns the database and every running session. The renderer reaches it over a WebSocket on 127.0.0.1 and nothing else — the boundary is real, not a convention.",
  },
  {
    title: "Your disk",
    body: "SQLite under ~/Realm. Transcripts are rebuilt from an append-only event log, so a relaunch restores exactly where you were and the next message resumes the provider session.",
  },
] as const

export function Stack() {
  return (
    <section id="stack" className="relative border-b border-line">
      <div className="mx-auto max-w-6xl px-6 py-24 lg:py-32">
        <SectionHeading
          eyebrow="The Realm stack"
          title="Six layers, one machine."
          lede="Every layer runs on your Mac and is replaceable on its own. Nothing here is a service you have to trust."
        />

        <ol className="mt-14 overflow-hidden rounded-xl border border-line">
          {layers.map((layer, i) => (
            <li
              key={layer.title}
              className="group relative grid gap-2 border-b border-line bg-canvas/40 px-6 py-7 transition-colors duration-300 last:border-b-0 hover:bg-surface/60 sm:grid-cols-12 sm:gap-8 sm:px-8"
            >
              {/* The accent rail lights the layer you are reading. */}
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-px bg-accent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              />
              <div className="flex items-baseline gap-4 sm:col-span-4">
                <span className="font-mono text-[12px] text-ink-3 tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="text-[17px] font-medium text-ink">{layer.title}</h3>
              </div>
              <p className="text-[15px] leading-relaxed text-ink-2 sm:col-span-8">{layer.body}</p>
            </li>
          ))}
        </ol>

        <div className="mt-4 rounded-xl border border-accent/30 bg-[linear-gradient(120deg,color-mix(in_srgb,var(--color-accent)_14%,transparent),transparent_60%)] px-6 py-7 sm:px-8">
          <div className="grid gap-2 sm:grid-cols-12 sm:gap-8">
            <h3 className="text-[17px] font-medium text-ink sm:col-span-4">Realm</h3>
            <p className="text-[15px] leading-relaxed text-ink-2 sm:col-span-8">
              All six, assembled into one window you own outright — no control plane in someone else's
              cloud, and no agent holding a credential it was never meant to see.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
