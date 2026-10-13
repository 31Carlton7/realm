"use client"

import { usePathname } from "next/navigation"
import type { ComponentProps } from "react"

import { PassageLink } from "./PassageLink"

/**
 * The way to the changelog from anywhere on the site, taking the passage that fits where the reader
 * is: a warp from the landing page, back up out of the doorway from an entry, and nothing from the
 * changelog itself.
 */
export function ChangelogLink(props: Omit<ComponentProps<typeof PassageLink<"/changelog">>, "href" | "passage">) {
  const path = usePathname()
  const passage = path === "/" ? "warp" : path?.startsWith("/changelog/") ? "surface" : undefined
  return <PassageLink href="/changelog" passage={passage} {...props} />
}
