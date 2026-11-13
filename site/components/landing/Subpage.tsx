import type { ReactNode } from "react"

import { Aperture } from "./Aperture"
import { Footer } from "./Footer"
import { Header, type Section } from "./Header"
import s from "./landing.module.css"

/**
 * A page past the landing one: the landing page's navy and type, its header on a band of the same
 * sky (no opening, and fading into the navy under it), and its foot. `head` is the page's title block,
 * set on the sky beside the header; it is one `data-clear` block, so no star lands in it. `indent` sets
 * it over the reading column of a page with a 10rem rail beside it, rather than over the rail.
 */
export function Subpage({
  current,
  head,
  indent = false,
  children,
}: {
  current?: Section
  head?: ReactNode
  indent?: boolean
  children: ReactNode
}) {
  return (
    <div className={`${s.page} ${s.subpage}`}>
      <section className={s.skyHead}>
        <Aperture className={s.skyBand} />
        <Header current={current} />
        {head ? (
          <div className={s.subHeadColumn}>
            <div className={s.subHead} data-indent={indent || undefined} data-clear>
              {head}
            </div>
          </div>
        ) : null}
      </section>
      {children}
      <Footer />
    </div>
  )
}
