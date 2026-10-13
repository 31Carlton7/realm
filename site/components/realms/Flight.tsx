"use client"

import { FieldCanvas } from "@/components/field/FieldCanvas"

import { RealmKeys } from "./RealmKey"
import { createRealms } from "./stage"

/**
 * The one canvas behind the whole page, and the flight it draws. The stage owns the camera; the page
 * owns the layout, and says where things are with `data-field-anchor`:
 *
 *   copy, portal     the opening's words and the product window
 *   k:<id>           the block of text a stop is composed around (its scroll position is the stop's)
 *   p:<id>           or the picture it is composed around, where the words stand above it
 *   s:<id>           the slot a chapter's screen comes to rest in, or where the team's realms stand
 *   c:<name>         any other block of words the field keeps its light off
 *
 * Under it, the deep sky's own black, so nothing of the page's grey shows before the field arrives;
 * and where there is no WebGPU, the field's opening sky held still (public/realms, photographed from
 * the live field), behind the whole page. Each chapter's realm also has a key for the keyboard
 * (RealmKey), which the field lays over it.
 */
export function Flight() {
  return (
    <>
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-20 bg-[#03050b]">
        <div className="absolute inset-0 hidden bg-[url(/realms/space-phone.webp)] bg-cover bg-top sm:bg-[url(/realms/space.webp)] [html[data-field=off]_&]:block" />
      </div>
      <FieldCanvas create={createRealms} />
      <RealmKeys />
    </>
  )
}
