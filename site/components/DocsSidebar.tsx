"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { docsNav } from "@/lib/site"

export function DocsSidebar() {
  const pathname = usePathname()

  return (
    <nav aria-label="Docs" className="space-y-7">
      {docsNav.map((group) => (
        <div key={group.title}>
          <h2 className="px-3 text-[11px] font-medium tracking-[0.1em] text-ink-3 uppercase">
            {group.title}
          </h2>
          <ul className="mt-2 space-y-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-lg px-3 py-1.5 text-[14px] transition-colors ${
                      active
                        ? "bg-surface text-ink"
                        : "text-ink-2 hover:bg-surface/60 hover:text-ink"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
