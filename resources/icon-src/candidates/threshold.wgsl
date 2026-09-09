// Threshold — a door ajar, light spilling through.
//
// Realm is a place you enter and leave things running in. The mark is the opening: a dark room, a
// vertical slot of light off-centre, the door's edge catching it. The silhouette at 16px is a dark
// field with one bright slit, which is about as legible as an icon gets.
//
// The slot is clamped to a minimum device width, so at 16px it widens rather than vanishing — the
// same trick the ring icon used on its core.

const SLOT_H: f32 = 0.30;      // half-height, fraction of ICON
const SLOT_X: f32 = 0.052;     // centre offset: a door ajar is not a door centred
const SLOT_W_DESIGN: f32 = 0.030;

fn interior(q: vec2f, pp: vec2f, px: f32) -> vec3f {
  // Never thinner than 1.1 device pixels each side of centre.
  let slotW = max(SLOT_W_DESIGN, 1.1 / (PX_PER_GRID * ICON));
  let p = q - vec2f(SLOT_X, 0.0);
  let slot = rounded(p, vec2f(slotW, SLOT_H), slotW);

  // Room: a cool dark gradient, darkened away from the opening so the light has somewhere to fall.
  let vy = clamp(q.y + 0.5, 0.0, 1.0);
  var c = mix(fromSrgb(BG_TOP), fromSrgb(BG_BOT), vy);
  c *= 1.0 - 0.42 * smoothstep(0.0, 0.5, length(q - vec2f(SLOT_X, 0.0)));

  // The light. Anisotropic falloff — wider across than along, because it is escaping through a gap.
  let spread = vec2f(0.72, 1.0);
  let glowD = rounded((q - vec2f(SLOT_X, 0.0)) * spread, vec2f(slotW, SLOT_H) * spread, slotW);
  let glow = exp(-max(glowD, 0.0) / 0.042);
  let bloom = exp(-max(glowD, 0.0) / 0.135);
  c += mix(ACCENT_DEEP, ACCENT, 0.6) * glow * 0.24;
  c += ACCENT_DEEP * bloom * 0.045;

  // The opening itself: white at the middle of the gap, accent at its edges.
  let inSlot = 1.0 - smoothstep(-px * 0.75 / ICON, px * 0.75 / ICON, slot);
  let across = clamp(abs(p.x) / max(slotW, 1e-5), 0.0, 1.0);
  let core = mix(vec3f(1.0), fromSrgb(ACCENT), across * across);
  // Falls off toward the ends of the slot, so it reads as a shaft rather than a painted bar.
  let alongEnd = 1.0 - smoothstep(0.55, 1.0, abs(p.y) / SLOT_H);
  c = mix(c, core * mix(0.45, 1.0, alongEnd), inSlot);

  // The door's edge, on the side the light is behind: a bright hairline, brightest at the top.
  let edgeW = max(0.004, 0.9 / (PX_PER_GRID * ICON));
  let edge = gauss(p.x + slotW + edgeW, edgeW) * (1.0 - smoothstep(0.6, 1.0, abs(p.y) / SLOT_H));
  c += mix(fromSrgb(ACCENT), vec3f(1.0), 0.35) * edge * 0.55 * mix(0.55, 1.0, 1.0 - vy);
  return c;
}
