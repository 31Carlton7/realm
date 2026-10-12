import { redirect } from "next/navigation"

/** The lab opens on the first new concept; the switcher at the foot of every concept reaches the rest. */
export default function HeroLabIndex() {
  redirect("/lab/hero/doorway")
}
