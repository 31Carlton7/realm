/**
 * The few rules the Live page needs that utilities cannot say: the one loop on the map (a working
 * agent's ring turning), held still under reduced motion like everything else.
 */
const CSS = `
.live-spin {
  transform-box: fill-box;
  transform-origin: center;
  animation: live-spin 2.6s linear infinite;
}
@keyframes live-spin {
  to { rotate: 360deg; }
}
@media (prefers-reduced-motion: reduce) {
  .live-spin { animation: none; }
}
`

export function LiveStyles() {
  return (
    <style href="realm-live-page" precedence="default">
      {CSS}
    </style>
  )
}
