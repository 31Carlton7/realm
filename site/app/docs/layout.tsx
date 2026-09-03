import { DocsSidebar } from "@/components/DocsSidebar"

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-6 pt-28 pb-24 lg:pt-36">
      <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-14">
        {/* Sticky on desktop, a plain block above the content on mobile — a docs sidebar that collapses
            into a drawer is more machinery than eight pages justify. */}
        <div className="mb-12 lg:sticky lg:top-28 lg:mb-0 lg:self-start">
          <DocsSidebar />
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  )
}
