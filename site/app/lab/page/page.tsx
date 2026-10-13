import { redirect } from "next/navigation"

/** The page lab opens on the first redesign; the switcher at the foot of every page reaches the rest. */
export default function PageLabIndex() {
  redirect("/lab/page/inside")
}
