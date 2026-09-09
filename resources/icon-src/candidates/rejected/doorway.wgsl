// Doorway — the stack, with the threshold inside it.
//
// The literal mix: three rooms stepping toward you, and the nearest one is not a lit slab but a
// dark panel with a door ajar in it. The light is the only saturated thing in the icon, which is
// what lets it stay legible when everything else is nearly black.

const ROOM: f32 = 0.246;
const STEP_DESIGN: f32 = 0.108;
const ROOM_N: f32 = 3.6;
const SLOT_H: f32 = 0.128;
const SLOT_X: f32 = 0.030;
const SLOT_W_DESIGN: f32 = 0.026;

const BACK_HI: vec3f = vec3f(0.180, 0.202, 0.259);
const BACK_LO: vec3f = vec3f(0.118, 0.133, 0.176);
const MID_HI: vec3f = vec3f(0.259, 0.290, 0.365);
const MID_LO: vec3f = vec3f(0.176, 0.196, 0.251);
const FRONT_HI: vec3f = vec3f(0.345, 0.388, 0.482);
const FRONT_LO: vec3f = vec3f(0.227, 0.255, 0.325);

fn interior(q: vec2f, pp: vec2f, px: f32) -> vec3f {
  let step = max(STEP_DESIGN, 2.2 / (PX_PER_GRID * ICON));
  let aa = px * 0.75 / ICON;
  let rimW = max(0.0045, 1.0 / (PX_PER_GRID * ICON));
  let slotW = max(SLOT_W_DESIGN, 1.0 / (PX_PER_GRID * ICON));

  let vy = clamp(q.y + 0.5, 0.0, 1.0);
  var c = mix(fromSrgb(vec3f(0.085, 0.094, 0.125)), fromSrgb(vec3f(0.020, 0.024, 0.034)), vy);
  c *= 1.0 - 0.25 * smoothstep(0.10, 0.68, length(q));

  let frontOffset = vec2f(step);
  let slotP = q - frontOffset - vec2f(SLOT_X, 0.0);
  let slot = rounded(slotP, vec2f(slotW, SLOT_H), slotW);

  // Light escaping the door, before anything is drawn over it: it falls on the shell and on the
  // rooms behind, which is what makes the stack read as one lit space rather than three cards.
  let spread = vec2f(0.72, 1.0);
  let glowD = rounded(slotP * spread, vec2f(slotW, SLOT_H) * spread, slotW);
  c += mix(fromSrgb(ACCENT_DEEP), fromSrgb(ACCENT), 0.6) * exp(-max(glowD, 0.0) / 0.055) * 0.30;
  c += fromSrgb(ACCENT_DEEP) * exp(-max(glowD, 0.0) / 0.16) * 0.06;

  for (var i = 0; i < 3; i = i + 1) {
    let offset = vec2f(1.0, 1.0) * (f32(i) - 1.0) * step;
    let p = q - offset;
    let d = superRect(p, vec2f(ROOM), ROOM_N);

    let castD = superRect(p + vec2f(0.011, 0.015), vec2f(ROOM), ROOM_N);
    c *= 1.0 - 0.62 * exp(-max(castD, 0.0) / 0.024);

    let inside = 1.0 - smoothstep(-aa, aa, d);
    let g = clamp((p.y + ROOM) / (2.0 * ROOM), 0.0, 1.0);
    var tone = mix(fromSrgb(BACK_HI), fromSrgb(BACK_LO), g);
    if (i == 1) { tone = mix(fromSrgb(MID_HI), fromSrgb(MID_LO), g); }
    if (i == 2) { tone = mix(fromSrgb(FRONT_HI), fromSrgb(FRONT_LO), g); }
    c = mix(c, tone, inside);

    let n = superNormal(p, vec2f(ROOM), ROOM_N, 0.0022);
    // The rooms behind are rim-lit by the door, not by the room light: their edges take the accent.
    let rim = gauss(d + rimW, rimW) * facingLight(n);
    let rimColour = select(mix(vec3f(1.0), fromSrgb(ACCENT), 0.55), vec3f(1.0), i == 2);
    c += rimColour * rim * 0.34;
  }

  // The opening itself, drawn last: it is in front of everything.
  let inFront = 1.0 - smoothstep(-aa, aa, superRect(q - frontOffset, vec2f(ROOM), ROOM_N));
  let inSlot = (1.0 - smoothstep(-aa, aa, slot)) * inFront;
  let across = clamp(abs(slotP.x) / max(slotW, 1e-5), 0.0, 1.0);
  let alongEnd = 1.0 - smoothstep(0.55, 1.0, abs(slotP.y) / SLOT_H);
  let core = mix(vec3f(1.0), fromSrgb(ACCENT), across * across) * mix(0.5, 1.0, alongEnd);
  c = mix(c, core, inSlot);
  return c;
}
