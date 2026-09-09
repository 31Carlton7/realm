
@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let pp = (uv - 0.5) * CANVAS;               // canvas pixels, origin centre, y down
  let q = pp / ICON;                           // icon-normalised, [-0.5, 0.5]
  let px = CANVAS / RES;                       // canvas px per render px
  let aa = px * 0.75;

  let d = squircle(pp, ICON * 0.5);
  let mask = 1.0 - smoothstep(-aa, aa, d);
  let ds = squircle(pp - vec2f(0.0, 10.0), ICON * 0.5);
  let shadow = 0.30 * gauss(max(ds, 0.0), 14.0);

  var c = interior(q, pp, px);

  // Glass: top rim light, bottom inner shadow, faint sheen. Identical for every candidate.
  let topness = clamp(0.5 - q.y * 1.4, 0.0, 1.0);
  let rim = gauss(d + 3.0, 2.2) * topness;
  c += vec3f(1.0) * rim * 0.34;
  let innerShade = gauss(d + 7.0, 9.0) * clamp(q.y * 1.5 + 0.2, 0.0, 1.0);
  c *= 1.0 - innerShade * 0.35;
  let sheen = smoothstep(0.55, -0.45, q.y);
  c += vec3f(0.025, 0.032, 0.050) * sheen * 0.24;

  var s = srgb(clamp(c, vec3f(0.0), vec3f(1.0)));
  s += (hash(uv * RES) - 0.5) / 255.0;
  let a = mask + shadow * (1.0 - mask);
  return vec4f(s * mask, a);                   // premultiplied
}
