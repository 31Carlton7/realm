"use client"

import { useEffect, useRef } from "react"

/**
 * The hero's space and its one opening, drawn by a WebGL2 fragment shader over the world it opens
 * onto (a `World` laid in the ring's box underneath).
 *
 * The ring's centre and radius are read from the `ring` element, so CSS places the opening at every
 * width. Outside it the shader draws deep navy space, opaque; inside it draws nothing but the ring's
 * light and a darkening toward the rim, so the world shows through.
 *
 * It moves once: on load the opening widens from a point of light to the ring, about a second and a
 * half, and then the loop stops. After that it draws only when its box changes size. Under reduced
 * motion it is drawn open, once.
 *
 * No star sits under text. Every element in the hero marked `data-clear` (the nav, the copy, the
 * caption) is read as the rect round its contents, grown by CLEAR_MARGIN, and the shader drops any star whose centre falls
 * inside one, fading over CLEAR_FEATHER beyond it. The rects are read again whenever the canvas or
 * any of those elements changes size, and once the fonts have loaded.
 */

const MAX_CLEAR = 12
/** Clear space round a text block, in CSS px: a few px of air plus the widest star's own radius. */
const CLEAR_MARGIN = 10
const CLEAR_FEATHER = 8

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec3 uRing;
uniform float uDpr;
uniform float uOpen;
#define MAX_CLEAR ${MAX_CLEAR}
uniform vec4 uClear[MAX_CLEAR];
uniform int uClearN;
uniform float uFeather;
out vec4 outColor;

float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p) { float n = h21(p); return vec2(n, h21(p + n)); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
// 0 inside any text block's rect (already grown by the margin), rising to 1 over uFeather beyond it.
float clearOf(vec2 p) {
  float m = 1.0;
  for (int i = 0; i < MAX_CLEAR; i++) {
    if (i >= uClearN) break;
    vec4 r = uClear[i];
    vec2 d = max(max(r.xy - p, p - r.zw), 0.0);
    m = min(m, smoothstep(0.0, uFeather, length(d)));
  }
  return m;
}

float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}

// Sparse, still points of light: one candidate per cell, most of them dim.
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
    float size = (0.5 + 0.8 * mag) * uDpr;
    // Masked by where the star's centre falls, so a star near text goes whole rather than cut in half.
    s += (0.15 + mag) * exp(-d * d / (size * size)) * clearOf((id + pos) * cell);
  }
  return s;
}

vec3 space(vec2 px, vec2 uv) {
  vec3 col = mix(vec3(0.008, 0.013, 0.036), vec3(0.022, 0.036, 0.082), smoothstep(0.0, 1.1, uv.y));
  float dust = fbm(px / (520.0 * uDpr));
  col += vec3(0.016, 0.024, 0.05) * smoothstep(0.5, 0.95, dust);
  float s = stars(px, 30.0 * uDpr, 0.09, 1.0) + 1.3 * stars(px, 84.0 * uDpr, 0.2, 7.0);
  return col + vec3(0.72, 0.8, 1.0) * s * 0.75;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 uv = px / uRes;
  vec2 q = (px - uRing.xy) / uRing.z;
  float R = uRing.z * uOpen;
  float d = length(px - uRing.xy) - R;
  // The edge, a little soft, so the opening never stair-steps.
  float inside = smoothstep(1.2 * uDpr, -1.2 * uDpr, d);
  // Lit from the upper left, where the world's brightest sky is.
  float ang = atan(q.y, q.x);
  float lit = pow(max(0.5 + 0.5 * cos(ang - 2.3), 0.0), 1.6);
  vec3 tint = mix(vec3(0.72, 0.83, 1.0), vec3(1.0, 0.9, 0.8), lit * 0.5);
  float w0 = 0.8 * uDpr;
  float core = exp(-d * d / (w0 * w0));
  float glow = exp(-abs(d) / (12.0 * uDpr));
  // While it opens the ring is a point of light that spends itself as it widens.
  float burst = 1.0 + 2.5 * (1.0 - uOpen) * (1.0 - uOpen);
  vec3 light = tint * (core * (0.18 + 0.95 * lit) + glow * (0.02 + 0.2 * lit)) * burst;
  // Inside, the world shows through, darkened toward the rim so the opening has depth.
  float rim = 1.0 - smoothstep(0.0, 0.16 * max(R, 1.0), -d);
  float shade = inside * 0.45 * rim;
  vec3 outside = space(px, uv) + light;
  float a = mix(1.0, shade, inside);
  vec3 c = mix(outside, light, inside);
  c += (h21(px) - 0.5) / 255.0 * 2.0 * (1.0 - inside) * clearOf(px);
  outColor = vec4(c, a);
}`

const OPEN_MS = 1500

export function Aperture({ ring, className }: { ring: React.RefObject<HTMLElement | null>; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    const gl = el?.getContext("webgl2", { antialias: false, premultipliedAlpha: true, alpha: true })
    if (!el || !gl) return
    const shader = (type: number, src: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader")
      return sh
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

    let open = 0
    const draw = () => {
      gl.uniform1f(u("uOpen"), open)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const box = el.getBoundingClientRect()
      el.width = Math.round(box.width * dpr)
      el.height = Math.round(box.height * dpr)
      gl.viewport(0, 0, el.width, el.height)
      gl.uniform2f(u("uRes"), el.width, el.height)
      gl.uniform1f(u("uDpr"), dpr)
      const slot = ring.current?.getBoundingClientRect()
      if (slot) {
        const cx = (slot.left - box.left + slot.width / 2) * dpr
        const cy = (box.bottom - (slot.top + slot.height / 2)) * dpr
        gl.uniform3f(u("uRing"), cx, cy, (slot.width / 2) * dpr)
      }
      const rects = new Float32Array(MAX_CLEAR * 4)
      clear.slice(0, MAX_CLEAR).forEach((node, i) => {
        // The contents' box, not the element's: a block stretched across the column would clear a
        // band of sky far wider than its words.
        range.selectNodeContents(node)
        const r = range.getBoundingClientRect()
        rects.set(
          [
            (r.left - box.left - CLEAR_MARGIN) * dpr,
            (box.bottom - r.bottom - CLEAR_MARGIN) * dpr,
            (r.right - box.left + CLEAR_MARGIN) * dpr,
            (box.bottom - r.top + CLEAR_MARGIN) * dpr,
          ],
          i * 4,
        )
      })
      gl.uniform4fv(u("uClear"), rects)
      gl.uniform1i(u("uClearN"), Math.min(clear.length, MAX_CLEAR))
      gl.uniform1f(u("uFeather"), CLEAR_FEATHER * dpr)
      draw()
    }
    const range = document.createRange()
    const clear = Array.from(el.parentElement?.querySelectorAll<HTMLElement>("[data-clear]") ?? [])
    size()
    const observer = new ResizeObserver(size)
    observer.observe(el)
    clear.forEach((node) => observer.observe(node))
    void document.fonts.ready.then(size)

    let frame = 0
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      open = 1
      draw()
    } else {
      const t0 = performance.now()
      const step = (now: number) => {
        const t = Math.min((now - t0) / OPEN_MS, 1)
        // A critically damped spring from rest, settled at t = 1.
        const k = 7
        open = t >= 1 ? 1 : 1 - (1 + k * t) * Math.exp(-k * t)
        draw()
        frame = t < 1 ? requestAnimationFrame(step) : 0
      }
      frame = requestAnimationFrame(step)
    }
    el.dataset.ready = "1"
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [ring])

  return <canvas ref={canvas} aria-hidden className={className} />
}
