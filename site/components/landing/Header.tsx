import Link from "next/link"

import { site } from "@/lib/site"

import { Mark } from "./Mark"
import s from "./landing.module.css"

export type Section = "docs" | "changelog"

/** The site's header on every page: the mark and the name, then Docs, Changelog and Source, with the
 *  section being read marked. Both blocks are `data-clear`, so the sky it sits on keeps its stars off them. */
export function Header({ current }: { current?: Section }) {
  return (
    <header className={s.nav}>
      <a href="/" className={s.brand} data-clear>
        <Mark className={s.brandMark} />
        <span>Realm</span>
      </a>
      <nav className={s.links} aria-label="Site" data-clear>
        <Link href="/docs" aria-current={current === "docs" ? "page" : undefined}>
          Docs
        </Link>
        <Link href="/changelog" aria-current={current === "changelog" ? "page" : undefined}>
          Changelog
        </Link>
        <a href={site.repo}>Source</a>
      </nav>
    </header>
  )
}
