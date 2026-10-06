/**
 * The page's last dimension: the edge of the world, with the realm rising over it.
 *
 * The mark's own lattice is laid flat as a floor and seen in perspective, running out to a horizon,
 * and the glass mark — the same `glassMark` the pinned track lit — rises from behind that horizon as
 * the page ends, reflected faintly in the floor. It is the lattice the page assembled the mark on,
 * seen from ground level: the section that explained a realm, turned into a place to stand.
 *
 * Expects, from the including shader: `field` with `footer` (presence, rise 0..1, CSS px per mark
 * unit, horizon as a fraction of the area's height) and `footerAt` (the area's rect), plus PAGE,
 * INK, ACCENT, ACCENT_INK, MARK_CENTER and `glassMark` from the faces module.
 */
export const footerWgsl = /* wgsl */ `
fn horizonY() -> f32 {
  return field.footerAt.y + field.footerAt.w * field.footer.w;
}

// Where the mark stands: centred across the area, its centre rising from well under the horizon to
// just above it. Under reduced motion it has already risen — the rise is scroll-linked motion, and
// a setting that asks for less of it should get the arrived state rather than the journey.
fn footerMarkCentre() -> vec2f {
  let rise = select(field.footer.y, 1.0, field.view.w > 0.5);
  let x = field.footerAt.x + field.footerAt.z * 0.5;
  return vec2f(x, horizonY() - mix(-30.0, 9.0, rise * rise * (3.0 - 2.0 * rise)) * field.footer.z);
}

// The floor: the same equilateral lattice as the mark's, in world units, projected onto a ground plane
// below the horizon and drifting toward the viewer. Fog takes it before the horizon does, which is
// what keeps the lines from aliasing into a moiré where perspective packs them tight.
fn footerFloor(p: vec2f, t: f32) -> f32 {
  let below = p.y - horizonY();
  let depth = 150.0 / max(below, 0.5);
  let cx = field.footerAt.x + field.footerAt.z * 0.5;
  let world = vec2f((p.x - cx) * depth / 560.0, depth + t * 0.3) / 0.19;
  var lines = 0.0;
  for (var k = 0; k < 3; k++) {
    let a = f32(k) * 1.0471976 + 1.5707963;
    let s = dot(world, vec2f(cos(a), sin(a)));
    let w = max(fwidth(s), 1e-4);
    lines = max(lines, 1.0 - smoothstep(0.0, w * 1.3, abs(fract(s + 0.5) - 0.5)));
  }
  return lines * exp(-depth * 0.085) * step(0.0, below);
}

fn footerLight(p: vec2f, t: f32) -> vec3f {
  let hy = horizonY();
  let d = p.y - hy;
  // The horizon: a hairline of light with a haze either side, brightest where the mark stands.
  let centre = footerMarkCentre();
  let across = exp(-abs(p.x - centre.x) / (field.footerAt.z * 0.32));
  var light = ACCENT_INK * exp(-abs(d) / 1.6) * (0.25 + across * 0.6);
  light += ACCENT * exp(-abs(d) / 70.0) * 0.14 * (0.4 + across);
  light += ACCENT * footerFloor(p, t) * 0.4;
  // The mark throws light into the sky close around it and onto the floor in front of it — close,
  // because a glow wide enough to tint the whole sky is blue standing in for hierarchy.
  let dm = length(p - centre) / max(field.footer.z, 1e-3);
  light += ACCENT * exp(-dm / 22.0) * 0.34 + ACCENT_INK * exp(-dm / 38.0) * 0.06;
  // The sky gives way to the page before the scene's top edge, where the footer's words begin.
  return light * smoothstep(field.footerAt.y - 20.0, field.footerAt.y + field.footerAt.w * 0.3, p.y);
}

// The mark above the horizon, and its reflection below it: the same point mirrored in the horizon,
// rippled a little and dimmer the further down the floor it lands.
fn footerSolid(p: vec2f, t: f32) -> vec4f {
  let hy = horizonY();
  let above = p.y < hy;
  let under = max(p.y - hy, 0.0);
  let ripple = sin(p.y * 0.09 + t * 1.3) * 2.2 * under / 40.0;
  let q = select(vec2f(p.x + ripple, 2.0 * hy - p.y), p, above);
  let unit = 1.0 / max(field.footer.z, 1e-3);
  let g = glassMark((q - footerMarkCentre()) * unit + MARK_CENTER, unit, t, 1.0, 0.0);
  // The part of the mark still below the horizon is behind it, and does not reflect either.
  let clip = smoothstep(0.0, 1.5, hy - q.y);
  let fade = select(0.3 * exp(-under / 120.0), 1.0, above);
  return vec4f(g.rgb, g.a * clip * fade);
}
`
