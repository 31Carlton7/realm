import { PageTransition } from "@/components/passage/PageTransition"

/** Remounted on every navigation between the changelog and its entries, so each is a passage
 *  (components/passage); the root template only remounts when the section changes. */
export default function Template({ children }: { children: React.ReactNode }) {
  return <PageTransition>{children}</PageTransition>
}
