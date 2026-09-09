// Rooms — layers' legibility, threshold's light.
//
// The synthesis. Layers II carries depth with three graded surfaces, which is good but makes the two
// rear rooms grey cards. Throughline carries it with lit edges, which is better looking and nearly
// invisible at 16px because nothing in it is solid.
//
// This keeps the solid lit room at the front — the thing that survives small and pulls the eye in a
// Dock — and makes the two behind it near-black panels rim-lit from within the stack. Depth is
// light, as in threshold; the mark is still a stack, as in layers.

const ROOM: f32 = 0.246;
const STEP_DESIGN: f32 = 0.108;
const ROOM_N: f32 = 3.6;

/** The rear rooms sit just above the shell, so their EDGES are what separates them, not their fill. */
const REAR_HI: vec3f = vec3f(0.125, 0.141, 0.184);
const REAR_LO: vec3f = vec3f(0.075, 0.086, 0.114);

fn interior(q: vec2f, pp: vec2f, px: f32) -> vec3f {
  let step = max(STEP_DESIGN, 2.2 / (PX_PER_GRID * ICON));
  let aa = px * 0.75 / ICON;
  let rimW = max(0.0052, 1.2 / (PX_PER_GRID * ICON));

  let vy = clamp(q.y + 0.5, 0.0, 1.0);
  var c = mix(fromSrgb(vec3f(0.085, 0.094, 0.125)), fromSrgb(vec3f(0.020, 0.024, 0.034)), vy);
  c *= 1.0 - 0.25 * smoothstep(0.10, 0.68, length(q));

  for (var i = 0; i < 3; i = i + 1) {
    let offset = vec2f(1.0, 1.0) * (f32(i) - 1.0) * step;
    let p = q - offset;
    let d = superRect(p, vec2f(ROOM), ROOM_N);
    let n = superNormal(p, vec2f(ROOM), ROOM_N, 0.0022);
    let faces = facingLight(n);

    // Light escaping past this panel's leading edge, onto whatever it sits on. Threshold's move.
    if (i < 2) {
      c += fromSrgb(ACCENT) * exp(-max(d, 0.0) / 0.048) * faces * (0.16 + 0.08 * f32(i));
    }

    let castD = superRect(p + vec2f(0.011, 0.015), vec2f(ROOM), ROOM_N);
    c *= 1.0 - 0.62 * exp(-max(castD, 0.0) / 0.024);

    let inside = 1.0 - smoothstep(-aa, aa, d);
    let g = clamp((p.y + ROOM) / (2.0 * ROOM), 0.0, 1.0);
    if (i < 2) {
      // Near-black, a shade apart. They are read by their edges.
      c = mix(c, mix(fromSrgb(REAR_HI), fromSrgb(REAR_LO), g) * (1.0 + 0.28 * f32(i)), inside);
    } else {
      var tone = mix(fromSrgb(ACCENT), fromSrgb(ACCENT_DEEP), g * 0.92);
      tone += vec3f(1.0) * pow(1.0 - g, 5.0) * 0.22;
      c = mix(c, tone, inside);
    }

    let rim = gauss(d + rimW, rimW) * faces;
    if (i < 2) {
      c += fromSrgb(ACCENT) * rim * (0.72 + 0.22 * f32(i));
    } else {
      c += mix(vec3f(1.0), fromSrgb(ACCENT), 0.30) * rim * 0.55;
    }
  }

  // The lit room throws a little accent onto the shell around it.
  let front = superRect(q - vec2f(step), vec2f(ROOM), ROOM_N);
  c += fromSrgb(ACCENT) * exp(-max(front, 0.0) / 0.085) * 0.075;
  return c;
}
