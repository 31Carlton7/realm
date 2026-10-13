/**
 * The few rules the Live page needs that utilities cannot say: the one loop on the map (a working
 * agent's ring turning) and a schedule's hand winding on, both held still under reduced motion like
 * everything else.
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
.live-dial {
  transition: transform 1100ms cubic-bezier(0.65, 0, 0.35, 1);
}
@media (prefers-reduced-motion: reduce) {
  .live-spin { animation: none; }
  .live-dial { transition: none; }
}
`

export function LiveStyles() {
  return (
    <style href="realm-live-page" precedence="default">
      {CSS}
    </style>
  )
}
