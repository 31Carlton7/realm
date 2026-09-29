/**
 * Realm's mark as geometry: the six faces of public/realm-mark.svg, flattened to polygons (each
 * rounded corner became three points), in the mark's own 40 x 48 viewBox. The union of the six is the
 * mark; their shared edges are where it changes facet.
 *
 * One copy, because design.md asks that anything drawing the mark derive it from the approved vector
 * rather than from geometry invented around it — and two copies is how one of them stops being it.
 */
export const FACES: readonly (readonly [number, number][])[] = [
  [[9.725, 41.798], [28.221, 41.798], [29.444, 41.582], [30.504, 40.969], [31.303, 40.018], [35.413, 32.899], [14.865, 32.899]],
  [[25.145, 15.101], [4.588, 15.101], [8.698, 7.982], [9.497, 7.032], [10.558, 6.419], [11.781, 6.203], [30.277, 6.203]],
  [[39.527, 25.78], [39.951, 24.612], [39.951, 23.388], [39.527, 22.221], [35.417, 15.101], [30.279, 24], [9.729, 24], [14.866, 32.899], [35.414, 32.899]],
  [[14.863, 32.899], [9.726, 24], [4.588, 32.899], [9.726, 41.798]],
  [[25.145, 15.101], [4.589, 15.101], [0.48, 22.221], [0.057, 23.388], [0.057, 24.612], [0.481, 25.78], [4.592, 32.899], [9.73, 24], [30.28, 24]],
  [[35.418, 15.101], [30.28, 6.203], [25.143, 15.101], [30.28, 24]],
]

/** The middle of the viewBox, which is the middle of the mark. */
export const MARK_CENTER: readonly [number, number] = [20, 24]
