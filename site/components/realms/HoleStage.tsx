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

/** The still's strands, as radius across, radius up, opacity and width (the shadow's radius is 100):
 *  close together and fading outward, the way the shader's plasma reads at that size. */
const HAT = Array.from({ length: 15 }, (_, i) => [112 + i * 6.2, 108 + i * 5.4, 0.8 * Math.exp(-i / 7), 3.4] as const)
const UNDER = Array.from({ length: 8 }, (_, i) => [106 + i * 5.2, 103 + i * 4.6, 0.5 * Math.exp(-i / 4), 3] as const)
const DISK = [140, 175, 215, 260, 310, 365, 425, 490] as const

/**
 * The hole without WebGPU: the shader's composition drawn once, in strands the way its plasma reads —
 * the far side of the disk lensed into the arc over the shadow and its underside's image below, the
 * near side crossing in front, the photon ring hugging the shadow, the side coming toward the camera
 * brighter, and the realms' doorways along the disk. A drawing, not a simulation.
 */
function FallbackHole() {
  const tilt = 0.12
  return (
    <svg
      aria-hidden
      viewBox="-520 -250 1040 480"
      preserveAspectRatio="xMidYMid meet"
      className="pointer-events-none absolute inset-x-0 top-[56%] mx-auto hidden h-[min(100%,72vw)] w-full max-w-[1100px] -translate-y-[52%] [html[data-field=off]_&]:block"
    >
      <defs>
        <linearGradient id="hole-beam" gradientUnits="userSpaceOnUse" x1="-500" x2="500" y1="0" y2="0">
          <stop offset="0" stopColor="oklch(0.86 0.06 250)" stopOpacity="0" />
          <stop offset="0.14" stopColor="oklch(0.88 0.06 250)" stopOpacity="0.55" />
          <stop offset="0.36" stopColor="oklch(0.97 0.02 250)" />
          <stop offset="0.62" stopColor="oklch(0.78 0.1 252)" stopOpacity="0.8" />
          <stop offset="0.86" stopColor="oklch(0.62 0.13 256)" stopOpacity="0.35" />
          <stop offset="1" stopColor="oklch(0.55 0.13 258)" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="hole-air">
          <stop offset="0.35" stopColor="oklch(0.62 0.13 255)" stopOpacity="0.12" />
          <stop offset="1" stopColor="oklch(0.62 0.13 255)" stopOpacity="0" />
        </radialGradient>
        <filter id="hole-soft" x="-10%" y="-40%" width="120%" height="180%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>
      <ellipse cx="0" cy="-10" rx="330" ry="210" fill="url(#hole-air)" />
      <g fill="none" stroke="url(#hole-beam)" strokeLinecap="round" filter="url(#hole-soft)">
        {/* The disk's far side beyond the arc, and the arc itself: the far side lensed over the top. */}
        {DISK.filter((rx) => rx > 230).map((rx) => (
          <path key={`back-${rx}`} d={`M ${-rx} 0 A ${rx} ${rx * tilt} 0 0 1 ${rx} 0`} strokeWidth={2.5} strokeOpacity={0.5 - rx / 1400} />
        ))}
        {HAT.map(([rx, ry, o, w]) => (
          <path key={`hat-${rx}`} d={`M ${-rx - 6} 4 A ${rx} ${ry} 0 0 1 ${rx + 6} 4`} strokeWidth={w} strokeOpacity={o} />
        ))}
        {UNDER.map(([rx, ry, o, w]) => (
          <path key={`under-${rx}`} d={`M ${-rx} 6 A ${rx} ${ry} 0 0 0 ${rx} 6`} strokeWidth={w} strokeOpacity={o} />
        ))}
      </g>
      <circle cx="0" cy="0" r="100" fill="oklch(0.07 0.004 264)" />
      <circle cx="0" cy="0" r="101.5" fill="none" stroke="oklch(0.93 0.03 250)" strokeOpacity="0.7" strokeWidth="1" />
      {/* The near side, crossing in front of the shadow. */}
      <g fill="none" stroke="url(#hole-beam)" strokeLinecap="round">
        {DISK.map((rx, i) => (
          <path key={`front-${rx}`} d={`M ${-rx} 0 A ${rx} ${rx * tilt} 0 0 0 ${rx} 0`} strokeWidth={i < 2 ? 3.2 : 2.2} strokeOpacity={Math.max(0.12, 0.95 - i * 0.12)} filter="url(#hole-soft)" />
        ))}
        <path d={`M ${-DISK[1]} 0 A ${DISK[1]} ${DISK[1] * tilt} 0 0 0 ${DISK[1]} 0`} strokeWidth={1.2} strokeOpacity={0.9} />
      </g>
      {/* A few realms' lit doorways riding the disk. */}
      <g fill="oklch(0.95 0.025 250)">
        {[-430, -372, -318, -262, -205, 228, 286, 344, 398, 452].map((x, i) => {
          const rx = Math.abs(x) + 12
          const y = (i % 2 ? 1 : -1) * Math.sqrt(Math.max(0, 1 - (x / rx) ** 2)) * rx * tilt + (i % 3) * 3
          return <rect key={x} x={x - 1} y={y - 3.5} width={2} height={7} rx={1} opacity={0.55 + (i % 3) * 0.12} />
        })}
      </g>
    </svg>
  )
}
