/**
 * Realm's mark in one ink: the cube's silhouette with its doorway knocked out, in `currentColor`, so it
 * takes the colour of whatever it sits in. The small and quiet drawing of the mark — glyphs, loading —
 * where the three-plane mark (assets/realm-mark.svg) would blur into one blue. The geometry is
 * resources/icon-src/mark-flat.svg's, which realm-mark.test.tsx holds this to.
 */
export const REALM_MARK_PATH =
  "M0.5196 24.9A1.8 1.8 0 0 1 0.5196 23.1L9.4804 7.5795A1.8 1.8 0 0 1 11.0392 6.6795L28.9608 6.6795A1.8 1.8 0 0 1 30.5196 7.5795L39.4804 23.1A1.8 1.8 0 0 1 39.4804 24.9L30.5196 40.4205A1.8 1.8 0 0 1 28.9608 41.3205L11.0392 41.3205A1.8 1.8 0 0 1 9.4804 40.4205ZM24.4 20.8823L28.2 14.3005L35.9 27.6373L32.1 34.2191Z";

/** The silhouette's own box inside the mark's 40 × 48: a glyph drawn in it is as tall as the hexagon,
 *  with none of the box's empty bands above and below. */
export const REALM_MARK_VIEWBOX = "0 6.6795 40 34.641";
/** Height over width of that box: a flat-topped hexagon is √3/2 as tall as it is wide. */
export const REALM_MARK_ASPECT = 34.641 / 40;
