import type { Metadata } from "next"

import { Aperture } from "@/components/portal/Aperture"
import { Hero } from "@/components/portal/Hero"
import s from "@/components/portal/portal.module.css"

/**
 * Round two's early look at "the aperture": the hero, and one of the six realms past it (the
 * Computer panel). A prototype, not the page: the other five sections and the scroll through the
 * ring come once a direction is picked.
 */
export const metadata: Metadata = { title: "Portal (prototype)", robots: { index: false, follow: false } }

export default function Portal() {
  return (
    <main className={s.page}>
      <Hero version="2.8.5" />
      <section className={s.realm} id="computer">
        <Aperture realm="violet" className={s.sky} />
        <div className={s.column}>
          <div className={s.claim}>
            <p className={s.index}>03</p>
            <h2 className={s.h2}>
              <span className={s.h2Quiet}>The Computer panel.</span> What&apos;s running, what needs you, what shipped.
            </h2>
            <p className={s.body}>
              Every teammate has one. Now shows the sessions it&apos;s running, with anything waiting on you first.
              On this Mac lists its terminals and browser tabs, and Done shows what each finished session merged or
              shipped, by day.
            </p>
          </div>
          <figure className={s.figure}>
            <div className={s.frame} aria-hidden>
              <span className={s.barShort} />
              <span className={s.barLong} />
              <span className={s.barMid} />
              <span className={s.barLong} />
              <span className={s.blockA} />
              <span className={s.blockB} />
            </div>
            <img
              className={s.shot}
              src="/portal/computer-dark.webp"
              width={760}
              height={546}
              alt="The Release Captain's Computer panel: one session waiting on you, two working, a build and a dev server running, and the sessions that shipped 2.8.2 and 2.8.3."
            />
            <figcaption className={s.caption}>
              The Release Captain&apos;s panel: one merge waiting on you, and a week of what shipped.
            </figcaption>
          </figure>
        </div>
      </section>
    </main>
  )
}
