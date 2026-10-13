"use client"

import { dropRealm } from "./blackhole"

/**
 * Where the flight ends: the rect the field draws the black hole into, at the foot of the page under
 * the footer. The hole is centred across it, a little below its middle.
 *
 * Clicking the hole drops a realm in at the point clicked; its button does the same from the keyboard
 * (a key's click carries no pointer, so the realm goes in at the disk's edge). Under reduced motion the
 * hole is a still and the button goes, since a drop is nothing but motion. Without WebGPU the
 * stylesheet draws the hole instead, as the shader's own composition held still.
 */
export function HoleStage() {
  return (
    <div data-field-anchor="hole" className="relative h-[clamp(340px,50vh,480px)] w-full sm:h-[clamp(400px,56vh,540px)]">
      <FallbackHole />
      <button
        type="button"
        aria-label="Drop a realm into the black hole"
        onClick={(event) => (event.detail === 0 ? dropRealm() : dropRealm(event.clientX, event.clientY))}
        className="peer absolute top-[56%] left-1/2 h-[clamp(110px,min(22vw,34vh),300px)] w-[clamp(300px,min(56vw,88vh),860px)] -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-full motion-reduce:hidden [html[data-field=off]_&]:hidden [html[data-field=pending]_&]:hidden"
      />
      <p
        aria-hidden
        className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 text-[13px] whitespace-nowrap text-ink-2 opacity-0 transition-opacity duration-200 peer-hover:opacity-100 peer-focus-visible:opacity-100 motion-reduce:hidden"
      >
        Drop a realm in
      </p>
    </div>
  )
}

/**
 * The hole without WebGPU: the shader's composition drawn once — the shadow, the photon ring hugging
 * it, the disk's near side crossing in front, its far side lensed into the arc over the top and the
 * underside's image below, the side coming toward the camera brighter. A drawing, not a simulation.
 */
function FallbackHole() {
  return (
    <svg
      aria-hidden
      viewBox="-500 -250 1000 500"
      preserveAspectRatio="xMidYMid meet"
      className="pointer-events-none absolute inset-x-0 top-[56%] mx-auto hidden h-[min(100%,78vw)] w-full max-w-[1100px] -translate-y-1/2 [html[data-field=off]_&]:block"
    >
      <defs>
        <linearGradient id="hole-beam" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="oklch(0.62 0.12 255)" stopOpacity="0" />
          <stop offset="0.22" stopColor="oklch(0.86 0.06 250)" stopOpacity="0.9" />
          <stop offset="0.42" stopColor="oklch(0.97 0.02 250)" />
          <stop offset="0.6" stopColor="oklch(0.7 0.12 255)" stopOpacity="0.8" />
          <stop offset="1" stopColor="oklch(0.5 0.12 258)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="hole-arc" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="oklch(0.9 0.05 250)" />
          <stop offset="0.55" stopColor="oklch(0.74 0.11 254)" />
          <stop offset="1" stopColor="oklch(0.6 0.13 256)" />
        </linearGradient>
        <radialGradient id="hole-air">
          <stop offset="0.3" stopColor="oklch(0.6 0.12 255)" stopOpacity="0.16" />
          <stop offset="1" stopColor="oklch(0.6 0.12 255)" stopOpacity="0" />
        </radialGradient>
        <filter id="hole-soft" x="-20%" y="-60%" width="140%" height="220%">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
      </defs>
      <ellipse cx="0" cy="0" rx="300" ry="190" fill="url(#hole-air)" />
      {/* The far side of the disk, lensed over the shadow, and its underside's image below. */}
      <path d="M -190 6 A 190 168 0 0 1 190 6" fill="none" stroke="url(#hole-arc)" strokeWidth="44" strokeOpacity="0.5" filter="url(#hole-soft)" />
      <path d="M -150 4 A 150 132 0 0 1 150 4" fill="none" stroke="url(#hole-arc)" strokeWidth="16" strokeOpacity="0.75" filter="url(#hole-soft)" />
      <path d="M -132 10 A 132 120 0 0 0 132 10" fill="none" stroke="url(#hole-arc)" strokeWidth="26" strokeOpacity="0.38" filter="url(#hole-soft)" />
      {/* The disk behind the shadow, the shadow, its photon ring, then the disk's near side in front. */}
      <ellipse cx="0" cy="8" rx="440" ry="20" fill="none" stroke="url(#hole-beam)" strokeWidth="9" strokeOpacity="0.55" filter="url(#hole-soft)" />
      <circle cx="0" cy="0" r="104" fill="oklch(0.08 0.004 264)" />
      <circle cx="0" cy="0" r="105" fill="none" stroke="oklch(0.92 0.04 250)" strokeOpacity="0.55" strokeWidth="1.2" />
      <path d="M -440 8 A 440 20 0 0 0 440 8" fill="none" stroke="url(#hole-beam)" strokeWidth="12" filter="url(#hole-soft)" />
      <path d="M -440 8 A 440 20 0 0 0 440 8" fill="none" stroke="url(#hole-beam)" strokeWidth="2.5" />
    </svg>
  )
}
