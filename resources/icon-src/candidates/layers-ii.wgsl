// Layers II — the same three rooms, given material.
//
// The first pass carried depth with flat tone steps, which is the thing that reads as cheap: three
// solid greys do not look stacked, they look printed. This carries it the way an object does —
// a graded surface, a lit leading edge that fades as it turns from the light, and a tight contact
// shadow where one room meets the next. No new idea, just the idea rendered.

const ROOM: f32 = 0.246;
const STEP_DESIGN: f32 = 0.108;
const ROOM_N: f32 = 3.6;

const BACK_HI: vec3f = vec3f(0.196, 0.220, 0.282);
const BACK_LO: vec3f = vec3f(0.129, 0.145, 0.192);
const MID_HI: vec3f = vec3f(0.290, 0.325, 0.404);
const MID_LO: vec3f = vec3f(0.204, 0.231, 0.294);

fn interior(q: vec2f, pp: vec2f, px: f32) -> vec3f {
  let step = max(STEP_DESIGN, 2.2 / (PX_PER_GRID * ICON));
  let aa = px * 0.75 / ICON;
  let rimW = max(0.0045, 1.0 / (PX_PER_GRID * ICON));

  // A deeper shell than the first pass. Premium is mostly black that stays black.
  let vy = clamp(q.y + 0.5, 0.0, 1.0);
  var c = mix(fromSrgb(vec3f(0.085, 0.094, 0.125)), fromSrgb(vec3f(0.020, 0.024, 0.034)), vy);
  c *= 1.0 - 0.25 * smoothstep(0.10, 0.68, length(q));

  for (var i = 0; i < 3; i = i + 1) {
    let offset = vec2f(1.0, 1.0) * (f32(i) - 1.0) * step;
    let p = q - offset;
    let d = superRect(p, vec2f(ROOM), ROOM_N);

    // Contact shadow: tight and dark under the leading edges, not a soft halo everywhere.
    let castD = superRect(p + vec2f(0.011, 0.015), vec2f(ROOM), ROOM_N);
    c *= 1.0 - 0.62 * exp(-max(castD, 0.0) / 0.024);

    let inside = 1.0 - smoothstep(-aa, aa, d);
    // Every surface graded along its own height, so no two rooms share a flat value.
    let g = clamp((p.y + ROOM) / (2.0 * ROOM), 0.0, 1.0);
    var tone = mix(fromSrgb(BACK_HI), fromSrgb(BACK_LO), g);
    if (i == 1) { tone = mix(fromSrgb(MID_HI), fromSrgb(MID_LO), g); }
    if (i == 2) {
      tone = mix(fromSrgb(ACCENT), fromSrgb(ACCENT_DEEP), g * 0.92);
      // The near edge of a lit surface catches more of it.
      tone += vec3f(1.0) * pow(1.0 - g, 5.0) * 0.22;
    }
    c = mix(c, tone, inside);

    // Lit leading edge, fading as the boundary turns away from the light.
    let n = superNormal(p, vec2f(ROOM), ROOM_N, 0.0022);
    let rim = gauss(d + rimW, rimW) * facingLight(n);
    let rimColour = select(vec3f(1.0), mix(vec3f(1.0), fromSrgb(ACCENT), 0.35), i == 2);
    c += rimColour * rim * select(0.30, 0.55, i == 2);
  }

  // The lit room is a light source: it throws a little accent onto the shell around it.
  let front = superRect(q - vec2f(step), vec2f(ROOM), ROOM_N);
  c += fromSrgb(ACCENT) * exp(-max(front, 0.0) / 0.085) * 0.085;
  return c;
}
