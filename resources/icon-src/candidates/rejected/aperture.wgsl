// Aperture — six iris blades around an opening.
//
// Keeps a circular silhouette, so an installed Realm does not become an unfamiliar app overnight,
// while dropping the glow entirely: this is a mechanism, hard-edged and faceted, rather than a lit
// orb. At 16px it reads as a faceted ring.
//
// The opening is the intersection of six half-planes — a hexagon — and the blade covering any point
// is whichever half-plane is furthest out there. That single argmax gives both the facets and the
// leading edges.

const BLADES: i32 = 6;
const OPEN_R_DESIGN: f32 = 0.178;   // hexagon inradius, fraction of ICON
const BLADE_R: f32 = 0.330;         // outer edge of the mechanism
const PHASE: f32 = 0.32;            // rotation, so the flats do not sit square to the pixel grid

fn interior(q: vec2f, pp: vec2f, px: f32) -> vec3f {
  let openR = max(OPEN_R_DESIGN, 1.6 / (PX_PER_GRID * ICON));
  let aa = px * 0.75 / ICON;

  let vy = clamp(q.y + 0.5, 0.0, 1.0);
  var c = mix(fromSrgb(BG_TOP), fromSrgb(BG_BOT), vy);
  c *= 1.0 - 0.26 * smoothstep(0.12, 0.62, length(q));

  // Which half-plane is furthest out here, and by how much.
  var best: f32 = -1e9;
  var bestI: i32 = 0;
  var second: f32 = -1e9;
  for (var i = 0; i < BLADES; i = i + 1) {
    let a = PHASE + 2.0 * PI * f32(i) / f32(BLADES);
    let n = vec2f(cos(a), sin(a));
    let d = dot(q, n) - openR;
    if (d > best) { second = best; best = d; bestI = i; }
    else if (d > second) { second = d; }
  }

  let ring = length(q) - BLADE_R;
  let inMech = (1.0 - smoothstep(-aa, aa, ring)) * smoothstep(-aa, aa, best);

  // Facets: each blade a step along a shallow ramp, lit from the top left.
  let a = PHASE + 2.0 * PI * f32(bestI) / f32(BLADES);
  let facing = 0.5 + 0.5 * dot(vec2f(cos(a), sin(a)), normalize(vec2f(-0.55, -1.0)));
  var blade = fromSrgb(vec3f(0.180, 0.202, 0.258)) * (0.55 + 1.15 * facing);
  // The leading edge, where two blades meet: a hairline that never drops below a device pixel.
  let seamW = max(0.0035, 0.8 / (PX_PER_GRID * ICON));
  let seam = 1.0 - smoothstep(0.0, seamW, abs(best - second));
  blade = mix(blade, fromSrgb(vec3f(0.42, 0.47, 0.56)), seam * 0.40);
  // The inner lip catches the light coming through.
  let lip = exp(-max(best, 0.0) / 0.030);
  blade += fromSrgb(ACCENT) * lip * 0.34;
  c = mix(c, blade, inMech);

  // The opening: light through the hexagon, brightest at its middle.
  let inOpen = 1.0 - smoothstep(-aa, aa, best);
  let depth = clamp(-best / max(openR, 1e-5), 0.0, 1.0);
  let light = mix(fromSrgb(ACCENT_DEEP), fromSrgb(ACCENT), sqrt(depth)) + vec3f(0.55) * pow(depth, 3.0);
  c = mix(c, light, inOpen);
  // and a little of it spilling past the mechanism onto the body.
  c += fromSrgb(ACCENT) * exp(-max(ring, 0.0) / 0.07) * 0.05;
  return c;
}
