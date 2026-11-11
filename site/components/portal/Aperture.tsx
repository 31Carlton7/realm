"use client"

import { useEffect, useRef } from "react"

/**
 * The sky behind a section of /portal, drawn by one WebGL2 fragment shader.
 *
 * In the hero it holds the aperture: a thin ring of light, its centre and radius read from the
 * `ring` element so CSS decides where it sits at every width, and through it the dawn of another
 * world. Every other section is the far side of a ring, a sky of its own over a horizon, named by
 * `realm`. Where WebGL2 is missing the container's CSS gradient is all that shows.
 */

export type Realm = "aperture" | "teal" | "amber" | "violet" | "silver"

/** horizon (fraction of height from the bottom), glow x (fraction of width), horizon tint, glow tint */
const SKIES: Record<Exclude<Realm, "aperture">, [number, number, [number, number, number], [number, number, number]]> = {
  teal: [0.2, 0.3, [0.1, 0.24, 0.27], [0.42, 0.62, 0.6]],
  amber: [0.2, 0.7, [0.24, 0.14, 0.09], [0.78, 0.5, 0.3]],
  violet: [0.12, 0.74, [0.17, 0.11, 0.29], [0.5, 0.36, 0.72]],
  silver: [0.2, 0.5, [0.15, 0.17, 0.22], [0.6, 0.65, 0.74]],
}

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uRing;
uniform float uDpr;
uniform int uMode;
uniform vec4 uSky;
uniform vec3 uHorizon;
uniform vec3 uGlow;
out vec4 outColor;

float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p) { float n = h21(p); return vec2(n, h21(p + n)); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}

// Sparse points of light: one candidate per cell, most of them dim, a few slowly breathing.
float stars(vec2 px, float cell, float keep, float seed) {
  vec2 g = px / cell, id = floor(g), f = fract(g);
  float s = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(x, y), cid = id + o;
    float r = h21(cid + seed);
    if (r > keep) continue;
    vec2 pos = o + 0.1 + 0.8 * h22(cid + seed * 1.7);
    float d = length((f - pos) * cell);
    float mag = pow(h21(cid + seed * 3.1), 2.6);
    float tw = 0.8 + 0.2 * sin(uTime * (0.25 + 0.5 * h21(cid)) + r * 40.0);
    float size = (0.5 + 0.8 * mag) * uDpr;
    s += (0.15 + mag) * tw * exp(-d * d / (size * size));
  }
  return s;
}

vec3 space(vec2 px, vec2 uv) {
  vec3 col = mix(vec3(0.008, 0.013, 0.036), vec3(0.022, 0.036, 0.082), smoothstep(0.0, 1.1, uv.y));
  float dust = fbm(px / (520.0 * uDpr) + vec2(uTime * 0.004, 0.0));
  col += vec3(0.016, 0.024, 0.05) * smoothstep(0.5, 0.95, dust);
  float s = stars(px, 30.0 * uDpr, 0.09, 1.0) + 1.3 * stars(px, 84.0 * uDpr, 0.2, 7.0);
  return col + vec3(0.72, 0.8, 1.0) * s * 0.75;
}

// The world through the ring, in the ring's own units (q = 0 at its centre, 1 at its rim, y up).
vec3 world(vec2 q, vec2 px) {
  float horizon = -0.5;
  float t = clamp((q.y - horizon) / 1.45, 0.0, 1.0);
  vec3 top = vec3(0.03, 0.09, 0.14), low = vec3(0.36, 0.55, 0.56);
  vec3 sky = mix(low, top, pow(t, 0.5));
  vec2 sun = vec2(-0.28, horizon + 0.04);
  vec2 ds = (q - sun) * vec2(1.0, 2.4);
  sky += vec3(0.95, 0.72, 0.5) * (0.5 * exp(-length(ds) * 3.2) + 0.14 * exp(-length(ds) * 1.1));
  sky += 0.035 * (fbm(q * vec2(2.2, 7.0) + vec2(uTime * 0.01, 0.0)) - 0.5) * (1.0 - t);
  sky += vec3(1.0, 0.92, 0.85) * stars(px, 46.0 * uDpr, 0.07, 13.0) * smoothstep(0.35, 0.9, t) * 0.45;
  float far = horizon + 0.012 + 0.03 * fbm(vec2(q.x * 1.6 + 3.0, 2.0));
  float near = horizon - 0.04 + 0.06 * fbm(vec2(q.x * 2.6, 5.0)) - 0.03 * q.x;
  vec3 land = vec3(0.03, 0.06, 0.075);
  vec3 col = sky;
  if (q.y < far) col = mix(mix(low, land, 0.55), low * 0.9, exp(-(far - q.y) * 40.0));
  if (q.y < near) col = mix(land, mix(low, land, 0.4), exp(-(near - q.y) * 9.0));
  return col;
}

// A realm's own sky over its horizon, for the sections past the ring.
vec3 beyond(vec2 px, vec2 uv) {
  float aspect = uRes.x / uRes.y;
  float hy = uSky.x;
  vec3 col = mix(vec3(0.01, 0.014, 0.036), vec3(0.016, 0.022, 0.05), uv.y);
  float above = uv.y - hy;
  vec2 g = vec2((uv.x - uSky.y) * aspect, above);
  float glow = exp(-length(g * vec2(0.9, 3.2)) * 2.6);
  col += uHorizon * exp(-max(above, 0.0) * 5.5) * 0.85 + uGlow * glow * 0.5;
  col += 0.02 * (fbm(px / (360.0 * uDpr) + vec2(uTime * 0.006, 0.0)) - 0.5) * exp(-max(above, 0.0) * 3.0);
  float s = stars(px, 34.0 * uDpr, 0.08, 3.0) + stars(px, 90.0 * uDpr, 0.2, 9.0);
  col += vec3(0.75, 0.8, 1.0) * s * 0.6 * smoothstep(0.05, 0.6, above);
  float ridge = hy - 0.004 + 0.018 * fbm(vec2(uv.x * 3.0 * aspect, 1.0));
  if (uv.y < ridge) col = mix(vec3(0.008, 0.01, 0.022), uHorizon * 0.7, exp(-(ridge - uv.y) * 60.0));
  return col;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 uv = px / uRes;
  vec3 col;
  if (uMode == 0) {
    col = space(px, uv);
    vec2 c = uRing.xy;
    float R = uRing.z;
    vec2 q = (px - c) / R;
    float r = length(q);
    float d = (r - 1.0) * R;
    // What lies past the opening, darkened near the rim so the ring reads as having depth.
    vec3 w = world(q, px) * mix(0.78, 1.0, smoothstep(0.0, 0.08, 1.0 - r));
    col = mix(col, w, smoothstep(1.2 * uDpr, -1.2 * uDpr, d));
    // The ring: a fine core, lit from the world's sun, with a little light spilled either side.
    float ang = atan(q.y, q.x);
    float lit = pow(max(0.5 + 0.5 * cos(ang + 2.2), 0.0), 1.6);
    vec3 tint = mix(vec3(0.72, 0.83, 1.0), vec3(1.0, 0.88, 0.76), lit * 0.55);
    float w0 = 0.8 * uDpr;
    float core = exp(-d * d / (w0 * w0));
    float glow = exp(-abs(d) / (12.0 * uDpr));
    float halo = exp(-max(d, 0.0) / (110.0 * uDpr));
    col += tint * (core * (0.12 + 1.05 * lit) + glow * (0.015 + 0.22 * lit)) + vec3(0.25, 0.35, 0.55) * halo * 0.04;
  } else {
    col = beyond(px, uv);
  }
  col += (h21(px + fract(uTime * 0.37)) - 0.5) / 255.0 * 2.0;
  outColor = vec4(col, 1.0);
}`

export function Aperture({ realm, ring, className }: { realm: Realm; ring?: React.RefObject<HTMLElement | null>; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    const gl = el?.getContext("webgl2", { antialias: false, premultipliedAlpha: false })
    if (!el || !gl) return
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader")
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    gl.useProgram(prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, "p")
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const u = (name: string) => gl.getUniformLocation(prog, name)
    gl.uniform1i(u("uMode"), realm === "aperture" ? 0 : 1)
    if (realm !== "aperture") {
      const [hy, gx, horizon, glow] = SKIES[realm]
      gl.uniform4f(u("uSky"), hy, gx, 0, 0)
      gl.uniform3f(u("uHorizon"), ...horizon)
      gl.uniform3f(u("uGlow"), ...glow)
    }

    let dpr = 1
    const size = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      const box = el.getBoundingClientRect()
      el.width = Math.round(box.width * dpr)
      el.height = Math.round(box.height * dpr)
      gl.viewport(0, 0, el.width, el.height)
      gl.uniform2f(u("uRes"), el.width, el.height)
      gl.uniform1f(u("uDpr"), dpr)
      const slot = ring?.current?.getBoundingClientRect()
      if (slot) {
        const cx = (slot.left - box.left + slot.width / 2) * dpr
        const cy = (box.bottom - (slot.top + slot.height / 2)) * dpr
        gl.uniform3f(u("uRing"), cx, cy, (slot.width / 2) * dpr)
      }
    }
    size()
    const observer = new ResizeObserver(size)
    observer.observe(el)

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const t0 = performance.now()
    let frame = 0
    const draw = (now: number) => {
      gl.uniform1f(u("uTime"), (now - t0) / 1000 + 40)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      if (!still) frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    el.dataset.ready = "1"
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [realm, ring])

  return <canvas ref={canvas} aria-hidden className={className} />
}
