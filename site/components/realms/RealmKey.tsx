"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"

import { openRealm } from "./hands"

/**
 * The keyboard's way to a chapter's realm: a button the field lays over the realm wherever it hangs
 * on the page, so focus draws its ring round the realm, focus lights it as the pointer would, and
 * Enter or Space throws its doorway open. It is there only while the realm is in view; under reduced
 * motion, and without the field, it goes, since what it does is nothing but motion.
 */
function RealmKey({ id }: { id: string }) {
  return (
    <button
      type="button"
      data-realm-key={id}
      aria-label="Open this realm's doorway"
      onClick={() => openRealm(id)}
      className="invisible fixed top-0 left-0 z-[1] origin-top-left cursor-pointer rounded-[14px] motion-reduce:hidden [html[data-field=off]_&]:hidden [html[data-field=pending]_&]:hidden"
    />
  )
}

/**
 * One realm key per chapter with a screen, each put at the end of its chapter's own section, so the
 * keyboard reaches it after the chapter's words and picture.
 */
export function RealmKeys() {
  const [chapters, setChapters] = useState<{ id: string; section: Element }[]>([])
  useEffect(() => {
    const found: { id: string; section: Element }[] = []
    for (const figure of document.querySelectorAll<HTMLElement>("[data-screen]")) {
      const id = figure.dataset.screen
      const section = figure.closest("section")
      if (id && section) found.push({ id, section })
    }
    setChapters(found)
  }, [])
  return <>{chapters.map(({ id, section }) => createPortal(<RealmKey id={id} />, section, id))}</>
}
