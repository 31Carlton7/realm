"use client"

import { createHive } from "@/components/lab/hive/stage"
import { Actions, Announcement, Headline, Lede, ProductWindow, type ConceptProps } from "@/components/lab/HeroParts"
import { LabCanvas } from "@/components/lab/LabCanvas"

/** A realm for every project: a field of spaces, each one the mark, lit where an agent is at work. */
export default function Hive({ download }: ConceptProps) {
  return (
    <section data-lab-anchor="stage" className="relative pb-24 sm:pb-32">
      <LabCanvas create={createHive} />
      <div className="mx-auto w-full max-w-[92rem] px-6 pt-12 sm:px-10 sm:pt-16 lg:pt-20">
        <div data-lab-anchor="copy">
          <Announcement />
          <div className="mt-8 grid gap-8 lg:mt-10 lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-end lg:gap-12">
            <Headline className="max-w-[12ch]" />
            <div className="lg:pb-2.5">
              <Lede />
              <Actions download={download} className="mt-7" />
            </div>
          </div>
        </div>
      </div>
      <ProductWindow className="mx-auto mt-14 w-full max-w-[72rem] px-4 sm:mt-24 sm:px-10 lg:mt-36" />
    </section>
  )
}
