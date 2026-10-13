"use client"

import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react"

import { FieldCanvas } from "@/components/field/FieldCanvas"
import { arriveAt, underway, viewWidth } from "@/components/passage/state"

import { arrivalStage, openingPoint, walkStage, type AvenueRelease } from "./stage"

/**
 * The box the sky draws in. `contain: paint` makes it the containing block of FieldCanvas's fixed
 * canvas, so the canvas is exactly this box: the viewport where the box is fixed, and a band of the
 * page where it is not, which then scrolls away with its band rather than holding its last frame over
 * the reading. The box is also the `stage` anchor, so the loop stops once it has left the view.
 *
 * Under it, the deep sky's own black, as the landing page lays it, and the landing page's opening sky
 * held still (public/realms, photographed from the live field). Until the field draws, the photograph
 * is the sky, softened so none of its realms stand where the field's will not, so a page never arrives
 * on bare black while its field starts up (a passage onto it shows the page at once). Once the field
 * has been drawing a moment it covers the photograph, which goes. Without WebGPU (`data-field="off"`)
 * the photograph is the whole of the sky, sharp. It has realms in it, so it is laid from the words'
 * edge (`photo` places it), never behind them.
 *
 * Its state is its own rather than read off `data-field` by the stylesheet, which on a page a passage
 * has just brought in still names the field of the page it left; and it lies under the canvas
 * (FieldCanvas's is `-z-10`), so the field covers it from its first frame.
 */
function Ground({ className, photo, children }: { className: string; photo: string; children: ReactNode }) {
  const [sky, setSky] = useState<"waiting" | "field" | "still">("waiting")
  useEffect(() => {
    const root = document.documentElement
    let timer = 0
    const read = () => {
      window.clearTimeout(timer)
      if (root.dataset.field === "off") setSky("still")
      else if (root.dataset.field === "on") timer = window.setTimeout(() => setSky("field"), 1200)
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(root, { attributes: true, attributeFilter: ["data-field"] })
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [])
  return (
    <div data-field-anchor="stage" aria-hidden className={`pointer-events-none -z-10 bg-[#03050b] [contain:paint] ${className}`}>
      <div
        data-sky={sky}
        className={`absolute inset-0 -z-20 bg-[url(/realms/space-phone.webp)] bg-cover bg-top sm:bg-[url(/realms/space.webp)] data-[sky=field]:invisible data-[sky=waiting]:blur-[22px] data-[sky=waiting]:brightness-90 ${photo}`}
      />
      {children}
    </div>
  )
}

/** The index's walk: behind the whole page on a wide screen, in the opening band on a narrow one,
 *  where its foot fades into the page's black. */
export function Walk({ releases }: { releases: AvenueRelease[] }) {
  // The passage the page arrived by, read as it mounts: the warp from the landing page, or a surface
  // back out of an entry.
  const [arrived] = useState(() => underway("warp") ?? underway("surface"))
  const create = useMemo(() => walkStage(releases, arrived), [releases, arrived])
  // A passage onto the index arrives at the realm the walk opens on (components/passage).
  useLayoutEffect(
    () =>
      arriveAt(() => {
        const list = document.querySelector('[data-field-anchor="c:list"]')?.getBoundingClientRect()
        const slot = document.querySelector('[data-field-anchor="s:avenue"]')?.getBoundingClientRect()
        const width = viewWidth()
        const [x, y] = openingPoint(list ? list.right : width / 2, width, window.innerHeight, slot ? [slot.left, slot.top, slot.width, slot.height] : null, width < 1024)
        return { x, y }
      }),
    [],
  )
  return (
    <Ground
      className="absolute inset-0 lg:fixed"
      photo="[mask-image:linear-gradient(to_bottom,black_30%,transparent_48%)] lg:left-[calc(max((100vw_-_92rem)/2,0px)_+_36.5rem)] lg:[mask-image:linear-gradient(to_right,transparent,black_10rem)] xl:left-[calc(max((100vw_-_92rem)/2,0px)_+_50.5rem)]"
    >
      <FieldCanvas create={create} />
      <div className="absolute inset-x-0 bottom-0 h-24 bg-[linear-gradient(to_bottom,transparent,#03050b)] lg:hidden" />
    </Ground>
  )
}

/** An entry's band: the release's realm, and the walk up to its doorway as the band scrolls away. */
export function Arrival({ release, total, dark }: { release: number; total: number; dark: boolean }) {
  // The dive the page arrived by, read as it mounts.
  const [dive] = useState(() => underway("dive"))
  const create = useMemo(() => arrivalStage(release, total, dark, dive), [release, total, dark, dive])
  // A passage onto an entry arrives at its release's doorway, where the band stands it.
  useLayoutEffect(
    () =>
      arriveAt(() => {
        const r = document.querySelector('[data-field-anchor="s:door"]')?.getBoundingClientRect()
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
      }),
    [],
  )
  return (
    <Ground
      className="absolute inset-0"
      photo="[mask-image:linear-gradient(to_bottom,black_26%,transparent_40%)] lg:left-[calc(max((100vw_-_92rem)/2,0px)_+_38.5rem)] lg:[mask-image:linear-gradient(to_right,transparent,black_10rem),linear-gradient(to_bottom,black_70%,transparent)] lg:[mask-composite:intersect] xl:left-[calc(max((100vw_-_92rem)/2,0px)_+_56.5rem)]"
    >
      <FieldCanvas create={create} />
      <div className="absolute inset-x-0 bottom-0 h-32 bg-[linear-gradient(to_bottom,transparent,#03050b)]" />
    </Ground>
  )
}
