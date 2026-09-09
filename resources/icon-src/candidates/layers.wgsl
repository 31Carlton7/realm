// Layered spaces — three rooms stepping toward you, the front one lit.
//
// The mark this project started with (resources/icon.svg at "the Realm mark — layered spaces, front
// room lit"), rebuilt for the constraint that killed the original: it was drawn as three 36px
// outlines on a 1024 grid, which is 0.56px at 16px and therefore invisible. These are solids with
// tonal separation, which survive.
//
// The step is clamped to a minimum device distance, so at 16px the three rooms stay three rooms
// instead of collapsing into one blob.

const ROOM: f32 = 0.267;       // half-size, fraction of ICON (440/1024 of the canvas, as the SVG had)
const STEP_DESIGN: f32 = 0.117;
const ROOM_N: f32 = 4.0;       // superellipse exponent: rounder than the shell, still of its family

const BACK: vec3f = vec3f(0.263, 0.294, 0.372);
const MID: vec3f = vec3f(0.412, 0.459, 0.561);

fn interior(q: vec2f, pp: vec2f, px: f32) -> vec3f {
  let step = max(STEP_DESIGN, 2.2 / (PX_PER_GRID * ICON));
  let aa = px * 0.75 / ICON;

  let vy = clamp(q.y + 0.5, 0.0, 1.0);
  var c = mix(fromSrgb(BG_TOP), fromSrgb(BG_BOT), vy);
  c *= 1.0 - 0.22 * smoothstep(0.15, 0.7, length(q));

  // Back to front along the diagonal. Each room casts a short shadow on the one behind it, which is
  // what keeps them separate when the tones are close.
  for (var i = 0; i < 3; i = i + 1) {
    let offset = vec2f(1.0, 1.0) * (f32(i) - 1.0) * step;
    let d = superRect(q - offset, vec2f(ROOM), ROOM_N);

    if (i > 0) {
      let castD = superRect(q - offset + vec2f(0.006, 0.006), vec2f(ROOM), ROOM_N);
      c *= 1.0 - 0.55 * exp(-max(castD, 0.0) / 0.028);
    }

    let inside = 1.0 - smoothstep(-aa, aa, d);
    var tone = fromSrgb(BACK);
    if (i == 1) { tone = fromSrgb(MID); }
    if (i == 2) {
      // The lit room: the accent across its diagonal, with the top edge catching the light.
      let t = clamp((q.x - offset.x + q.y - offset.y) / (4.0 * ROOM) + 0.5, 0.0, 1.0);
      tone = mix(fromSrgb(ACCENT), fromSrgb(ACCENT_DEEP), t);
      let top = 1.0 - smoothstep(0.0, 0.42, (q.y - offset.y + ROOM) / (2.0 * ROOM) * 2.0);
      tone += vec3f(1.0) * top * 0.30;
    }
    c = mix(c, tone, inside);
  }
  return c;
}
