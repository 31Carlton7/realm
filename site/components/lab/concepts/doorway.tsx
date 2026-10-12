"use client"

import { Actions, Announcement, Headline, Lede, ProductWindow, type ConceptProps } from "@/components/lab/HeroParts"

/** Placeholder until the Doorway concept is built: the hero's words and product, with no light yet. */
export default function Doorway({ download }: ConceptProps) {
  return (
    <section data-lab-anchor="stage" className="relative pb-24 sm:pb-32">
      <div className="mx-auto w-full max-w-[92rem] px-6 pt-12 sm:px-10 sm:pt-16 lg:pt-20">
        <Announcement />
        <div className="mt-8 grid gap-8 lg:mt-10 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-end lg:gap-12">
          <Headline className="max-w-[12ch]" />
          <div className="lg:pb-2.5">
            <Lede />
            <Actions download={download} className="mt-7" />
          </div>
        </div>
      </div>
      <ProductWindow className="mx-auto mt-14 w-full max-w-[82rem] px-4 sm:mt-16 sm:px-10" />
    </section>
  )
}
