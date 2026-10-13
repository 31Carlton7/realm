/**
 * The glass mark as the live drawing paints it with the lamp at rest, kept as a picture
 * (public/lab/paper/glass-still.webp, a capture of the canvas at twice the density). It lies under the
 * canvas: before the light is ready the page shows exactly what the canvas will paint, so nothing jumps
 * when it fades in, and a browser without WebGPU keeps it as the drawing. A compressed picture can
 * drift a code value off the page's colour, so its edges fade into the page rather than meet it.
 */
export function GlassStill() {
  return (
    <img
      src="/lab/paper/glass-still.webp"
      alt=""
      aria-hidden
      width={1416}
      height={944}
      decoding="async"
      className="absolute inset-0 h-full w-full select-none [mask-composite:intersect] [mask-image:linear-gradient(to_right,transparent,#000_5%,#000_95%,transparent),linear-gradient(to_bottom,transparent,#000_6%,#000_94%,transparent)]"
    />
  )
}
