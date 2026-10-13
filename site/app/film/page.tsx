import type { Metadata } from "next"

import { Film } from "@/components/film/Film"

export const metadata: Metadata = {
  title: "Launch film",
  robots: { index: false, follow: false },
}

/**
 * The source of Realm's launch film. scripts/film-capture.mjs opens this with `?capture`, steps it frame
 * by frame and encodes what it photographs; opened plainly it plays on a loop. Nothing links here.
 */
export default function FilmPage() {
  return <Film />
}
