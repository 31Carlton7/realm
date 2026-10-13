import { DOOR, FACES } from "@/lib/mark"

const path = (points: readonly (readonly [number, number])[]) =>
  `M${points.map(([x, y]) => `${x} ${y}`).join("L")}Z`

const face = (name: string) => FACES.find((f) => f.name === name)!.polygon

/**
 * The glass mark drawn plainly, for a browser without WebGPU and for the moment before the light is
 * ready: the same block, lit from the upper left, with its shadow on the paper and the light it bends
 * gathered at the shadow's near edge. Laid in the canvas's own geometry (the mark half the square's
 * width, centred), so the live drawing fades in over it without a jump.
 */
export function GlassStill() {
  const silhouette = [face("top"), face("left"), face("right")]
  return (
    <svg
      viewBox="-20 -16 80 80"
      preserveAspectRatio="xMidYMid meet"
      className="absolute inset-0 h-full w-full [html[data-lab-field=on]_&]:hidden"
      aria-hidden
    >
      <defs>
        <filter id="paper-glass-soft" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
        <filter id="paper-glass-softer" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="0.9" />
        </filter>
        <linearGradient id="paper-glass-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="oklch(0.995 0.003 264)" />
          <stop offset="1" stopColor="oklch(0.95 0.006 264)" />
        </linearGradient>
        <linearGradient id="paper-glass-left" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0" stopColor="oklch(0.93 0.008 264)" />
          <stop offset="1" stopColor="oklch(0.89 0.012 260)" />
        </linearGradient>
        <linearGradient id="paper-glass-right" x1="0" y1="0" x2="1" y2="0.4">
          <stop offset="0" stopColor="oklch(0.9 0.012 260)" />
          <stop offset="1" stopColor="oklch(0.84 0.016 258)" />
        </linearGradient>
      </defs>
      {/* The shadow, thrown down and to the right, and the light the block gathers inside it. */}
      <g transform="translate(5.5 7)" filter="url(#paper-glass-soft)" opacity="0.5">
        {silhouette.map((p, i) => (
          <path key={i} d={path(p)} fill="oklch(0.62 0.01 264)" />
        ))}
      </g>
      <g transform="translate(3.4 4.6)" filter="url(#paper-glass-softer)" opacity="0.85">
        <path d={path(face("right"))} fill="oklch(0.99 0.004 260)" transform="translate(20 24) scale(0.46) translate(-20 -24)" />
      </g>
      <path d={path(face("top"))} fill="url(#paper-glass-top)" />
      <path d={path(face("left"))} fill="url(#paper-glass-left)" />
      <path d={path(face("right"))} fill="url(#paper-glass-right)" />
      <path d={path(face("lit"))} fill="oklch(0.985 0.004 264)" />
      <path d={path(face("floor"))} fill="oklch(0.93 0.008 264)" />
      <path d={path(face("jamb"))} fill="oklch(0.86 0.012 260)" />
      <path d={path(DOOR)} fill="none" stroke="oklch(1 0 0 / 0.9)" strokeWidth="0.18" />
      {silhouette.map((p, i) => (
        <path key={i} d={path(p)} fill="none" stroke="oklch(1 0 0 / 0.85)" strokeWidth="0.22" strokeLinejoin="round" />
      ))}
    </svg>
  )
}
