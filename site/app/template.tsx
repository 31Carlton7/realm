import { PageTransition } from "@/components/passage/PageTransition"

/** Remounted on every navigation between the site's sections, so each is a passage (components/passage). */
export default function Template({ children }: { children: React.ReactNode }) {
  return <PageTransition>{children}</PageTransition>
}
