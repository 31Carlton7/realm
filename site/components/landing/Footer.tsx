import Link from "next/link"

import worlds from "@/content/worlds.json"
import { site } from "@/lib/site"

import s from "./landing.module.css"

/**
 * The site's foot: the links and who makes Realm, on every page. Only the landing page shows the app's
 * pictures, so only it passes `credits` for them.
 */
export function Footer({ credits = false }: { credits?: boolean }) {
  return (
    <footer className={s.foot}>
      <div className={s.footColumn}>
        {credits ? (
          <p className={s.credits}>
            The pictures are the ones Realm shows behind a new session.{" "}
            {worlds.map((w) => (
              <span key={w.id} className={s.credit}>
                {w.name}: {w.credit}
              </span>
            ))}
          </p>
        ) : null}
        <div className={s.footSide}>
          <nav className={s.footLinks} aria-label="More">
            <Link href="/docs">Docs</Link>
            <Link href="/changelog">Changelog</Link>
            <a href={site.repo}>Source</a>
          </nav>
          <p className={s.madeBy}>
            Made by <a href={site.author.site.href}>{site.author.name}</a>.{" "}
            <a href={site.author.x.href}>{site.author.x.handle}</a>
          </p>
        </div>
      </div>
    </footer>
  )
}
