"use client"

import { usePathname } from "next/navigation"
import type { ComponentProps } from "react"

import { PassageLink } from "./PassageLink"
import { passageBetween } from "./state"

type Props = Omit<ComponentProps<typeof PassageLink<"/changelog">>, "href" | "passage">

/**
 * The way to the changelog from anywhere on the site, taking the passage that fits where the reader
 * is: a warp from the landing page, back up out of the doorway from an entry, and nothing from the
 * changelog itself.
 */
export function ChangelogLink(props: Props) {
  const path = usePathname() ?? ""
  return <PassageLink href="/changelog" passage={passageBetween(path, "/changelog") ?? undefined} {...props} />
}

/** The way home from anywhere on the site: from the changelog or an entry, the warp run backwards. */
export function HomeLink(props: Omit<ComponentProps<typeof PassageLink<"/">>, "href" | "passage">) {
  const path = usePathname() ?? ""
  return <PassageLink href="/" passage={passageBetween(path, "/") ?? undefined} {...props} />
}
