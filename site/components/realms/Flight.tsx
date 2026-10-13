"use client"

import { FieldCanvas } from "@/components/field/FieldCanvas"

import { createRealms } from "./stage"

/**
 * The one canvas behind the whole page, and the flight it draws. The stage owns the camera; the page
 * owns the layout, and says where things are with `data-field-anchor`:
 *
 *   copy, portal     the opening's words and the product window
 *   k:<id>           the block of text a stop is composed around (its scroll position is the stop's)
 *   s:<id>           the slot a chapter's screen comes to rest in, or where the team's realms stand
 *   c:<name>         any other block of words the field keeps its light off
 */
export function Flight() {
  return <FieldCanvas create={createRealms} />
}
