/**
 * The glass mark as the live drawing paints it with the lamp at rest, kept as a picture
 * (public/lab/paper/glass-still.webp, a capture of the canvas at twice the density). It lies under the
 * canvas: before the light is ready the page shows exactly what the canvas will paint, so nothing jumps
 * when it fades in, and a browser without WebGPU keeps it as the drawing.
 */
export function GlassStill() {
  return (
    <img
      src="/lab/paper/glass-still.webp"
      alt=""
      aria-hidden
      width={1202}
      height={1000}
      decoding="async"
      className="absolute inset-0 h-full w-full select-none"
    />
  )
}
