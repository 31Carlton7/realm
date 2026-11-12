import type { ReactNode } from "react"

import early from "@/content/early.json"
import worlds from "@/content/worlds.json"
import type { Downloads } from "@/lib/release"
import { site } from "@/lib/site"

import { Crop, type Picture, type Shot } from "./Crop"
import { Hero } from "./Hero"
import { World } from "./World"
import s from "./landing.module.css"

const world = (id: string) => {
  const found = worlds.find((w) => w.id === id)
  if (!found) throw new Error(`no world "${id}" in content/worlds.json`)
  return found
}

const captures: Record<string, { w: number; h: number }> = early
const picture = (name: string): Picture => {
  const size = captures[name]
  if (!size) throw new Error(`no capture "${name}" in content/early.json`)
  return { src: `/early/${name}.webp`, src1x: `/early/${name}-1x.webp`, ...size }
}
const shot = (name: string, alt: string, phone?: string): Shot => ({ ...picture(name), alt, ...(phone ? { phone: picture(phone) } : {}) })

/**
 * The landing page, round three: deep navy space with one opening onto a world, and past it, each
 * section in one of the worlds Realm itself opens new sessions onto, with one component from the app
 * in it. The worlds are the app's own pictures (scripts/copy-worlds.mjs), credited at the foot.
 */
export function Landing({ downloads, version, changelog }: { downloads: Downloads; version: string; changelog: string }) {
  return (
    <main className={s.page}>
      <Hero
        downloads={downloads}
        version={version}
        changelog={changelog}
        world={world("webb")}
        session={shot(
          "session",
          `A new, empty session in Realm on the Cosmic Cliffs picture, asking "What's next in Realm?" over the prompter, set to Opus 5.5.`,
          "session-phone",
        )}
      />

      <Realm
        id="teammates"
        world={world("church")}
        focus={[0.5, 0.6]}
        stage="corner"
        quiet="Teammates and their Lead."
        claim="Tell the Lead what you need and it asks the teammate who fits."
        body={
          <>
            A teammate is an agent that stays in your space, with its own name, job, model and folder. The Lead&apos;s
            chat shows who it asked and whether they&apos;re working or done. Tell it to give a teammate more access and
            it will, with a line in both chats and an Undo. It only does that in a turn you started, and never above its
            own access.
          </>
        }
        main={shot(
          "lead",
          `The Lead's chat. It asked Desktop Polish, Engines and Docs Writer for parts of a release; Engines is working and the other two are done. Below, after "give polish full access", a line says the Lead set @polish to Full access at your request, with an Undo.`,
          "lead-phone",
        )}
        caption="The Lead's chat: three teammates asked, then @polish raised to Full access."
      />

      <Realm
        id="computer"
        world={world("hubble")}
        stage="pair"
        quiet="Team access and the Computer tab."
        claim="Set the whole team's access once, then see what each teammate is doing."
        body={
          <>
            Team access sits at the head of the Team list. One setting puts every teammate in a space on Ask each time,
            Accept edits or Full access, and Full access asks you to confirm first. Each teammate has a Computer tab that
            shows what needs you, what&apos;s working now, what its sessions hold open on this Mac, and what each finished
            session merged or shipped.
          </>
        }
        main={shot(
          "computer",
          "A teammate's Computer tab: Now lists a merge waiting on you and two sessions working, On this Mac lists a build, a dev server and a browser tab, and Done lists finished sessions by day with the pull requests they merged and the releases they shipped.",
          "computer-phone",
        )}
        aside={shot("access", "The sidebar's Team access row set to Full access, over the team's four teammates.")}
        caption="The Release Captain's Computer tab, and Team access on Full access."
      />

      <footer className={s.foot}>
        <div className={s.footColumn}>
          <p className={s.credits}>
            The pictures are the ones Realm shows behind a new session.{" "}
            {worlds.map((w) => (
              <span key={w.id} className={s.credit}>
                {w.name}: {w.credit}
              </span>
            ))}
          </p>
          <nav className={s.footLinks} aria-label="More">
            <a href="/docs">Docs</a>
            <a href="/changelog">Changelog</a>
            <a href={site.repo}>Source</a>
          </nav>
        </div>
      </footer>
    </main>
  )
}

type RealmProps = {
  id: string
  world: { file: string; name: string }
  quiet: string
  claim: string
  body: ReactNode
  main: Shot
  aside?: Shot
  caption: string
  /** Where the world's subject sits, kept in the frame. */
  focus?: [number, number]
  /**
   * How the figure sits under the claim, at the column's full width. `corner`: one component in the
   * frame's upper right, so the world's horizon shows below and beside it. `pair`: two components side
   * by side, stacked when they do not fit. Every crop on a stage shares one scale, its size in the app.
   */
  stage: "corner" | "pair"
}

/** One section: its claim, and one component from the app set in one of the app's worlds. */
function Realm({ id, world, quiet, claim, body, main, aside, caption, focus = [0.5, 0.5], stage }: RealmProps) {
  return (
    <section className={s.realm} aria-labelledby={`${id}-title`} data-stage={stage}>
      <div className={s.column}>
        <div className={s.claim}>
          <h2 className={s.h2} id={`${id}-title`}>
            <span className={s.h2Quiet}>{quiet}</span> {claim}
          </h2>
          <p className={s.body}>{body}</p>
        </div>
        <figure>
          <div className={s.frame}>
            <World file={world.file} x={focus[0]} y={focus[1]} className={s.frameWorld} />
            <div className={s.stage}>
              {aside && <Crop shot={aside} />}
              <Crop shot={main} />
            </div>
          </div>
          <figcaption className={s.caption}>{caption}</figcaption>
        </figure>
      </div>
    </section>
  )
}
