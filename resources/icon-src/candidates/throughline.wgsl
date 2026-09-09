// Throughline — three dark rooms, lit from behind.
//
// The other way to mix the two: keep layers' geometry and let threshold supply all the light. No
// room is filled with colour. What you see is three near-black panels whose leading edges are lit
// by something further in, so the depth is carried entirely by where the light falls — which is how
// depth works.
//
// It is the quietest of the three and the one that stays a dark icon at every size.

const ROOM: f32 = 0.246;
const STEP_DESIGN: f32 = 0.108;
const ROOM_N: f32 = 3.6;

const PANEL_HI: vec3f = vec3f(0.153, 0.173, 0.220);
const PANEL_LO: vec3f = vec3f(0.086, 0.098, 0.129);

fn interior(q: vec2f, pp: vec2f, px: f32) -> vec3f {
  let step = max(STEP_DESIGN, 2.2 / (PX_PER_GRID * ICON));
  let aa = px * 0.75 / ICON;
  // The lit edge is the whole mark here, so it never drops below a device pixel and a half.
  let rimW = max(0.0060, 1.5 / (PX_PER_GRID * ICON));

  let vy = clamp(q.y + 0.5, 0.0, 1.0);
  var c = mix(fromSrgb(vec3f(0.078, 0.086, 0.114)), fromSrgb(vec3f(0.018, 0.021, 0.030)), vy);
  c *= 1.0 - 0.24 * smoothstep(0.10, 0.68, length(q));

  for (var i = 0; i < 3; i = i + 1) {
    let offset = vec2f(1.0, 1.0) * (f32(i) - 1.0) * step;
    let p = q - offset;
    let d = superRect(p, vec2f(ROOM), ROOM_N);
    let n = superNormal(p, vec2f(ROOM), ROOM_N, 0.0022);
    let faces = facingLight(n);

    // Light spilling from behind this panel's leading edge, onto whatever it sits on.
    c += fromSrgb(ACCENT) * exp(-max(d, 0.0) / 0.052) * faces * (0.14 + 0.10 * f32(i));

    let castD = superRect(p + vec2f(0.011, 0.015), vec2f(ROOM), ROOM_N);
    c *= 1.0 - 0.66 * exp(-max(castD, 0.0) / 0.026);

    let inside = 1.0 - smoothstep(-aa, aa, d);
    let g = clamp((p.y + ROOM) / (2.0 * ROOM), 0.0, 1.0);
    // Each panel a shade lighter than the one behind, but all of them dark.
    let lift = 1.0 + 0.30 * f32(i);
    c = mix(c, mix(fromSrgb(PANEL_HI), fromSrgb(PANEL_LO), g) * lift, inside);

    // The lit edge. Accent at the two behind, burning to white at the front.
    let rim = gauss(d + rimW, rimW) * faces;
    let hot = select(0.0, 0.55, i == 2);
    c += mix(fromSrgb(ACCENT), vec3f(1.0), hot) * rim * (0.55 + 0.28 * f32(i));
  }
  return c;
}
