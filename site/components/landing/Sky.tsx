"use client"

import { useEffect, useRef } from "react"

import { CLEAR_FEATHER, MAX_CLEAR, STAR_GROWTH, STAR_SIZE, clearBoxes, toShader } from "./star-mask"

/**
 * The landing page's deep navy space, drawn once by a WebGL2 fragment shader: a little dust and sparse,
 * still stars. The hero is drawn on it, and so is the band under a subpage's header. It draws again
 * only when its box changes size, so it is the same under reduced motion.
 *
 * No star sits under text. Every element beside it marked `data-clear` (the nav, the copy, the
 * caption) is read as the rect round its contents, grown by CLEAR_MARGIN, and the shader drops any
 * star whose centre falls inside one, fading over CLEAR_FEATHER beyond it (star-mask.ts, whose tests
 * hold it to that). The rects are read again whenever the canvas or any of those elements changes
 * size, and once the fonts have loaded.
 */

const glsl = (n: number) => n.toFixed(3)

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uDpr;
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
    float size = (${glsl(STAR_SIZE)} + ${glsl(STAR_GROWTH)} * mag) * uDpr;
    // Masked by where the star's centre falls, so a star near text goes whole rather than cut in half.
    s += (0.15 + mag) * exp(-d * d / (size * size)) * clearOf((id + pos) * cell);
  }
  return s;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 uv = px / uRes;
  vec3 col = mix(vec3(0.008, 0.013, 0.036), vec3(0.022, 0.036, 0.082), smoothstep(0.0, 1.1, uv.y));
  float dust = fbm(px / (520.0 * uDpr));
  col += vec3(0.016, 0.024, 0.05) * smoothstep(0.5, 0.95, dust);
  float s = stars(px, 30.0 * uDpr, 0.09, 1.0) + 1.3 * stars(px, 84.0 * uDpr, 0.2, 7.0);
  col += vec3(0.72, 0.8, 1.0) * s * 0.75;
  // A level of noise so the gradient never bands, kept off the text like the stars.
  col += (h21(px) - 0.5) / 255.0 * 2.0 * clearOf(px);
  outColor = vec4(col, 1.0);
}`

export function Sky({ className }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    const gl = el?.getContext("webgl2", { antialias: false, alpha: false })
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

    const range = document.createRange()
    const clear = Array.from(el.parentElement?.querySelectorAll<HTMLElement>("[data-clear]") ?? [])
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const box = el.getBoundingClientRect()
      el.width = Math.round(box.width * dpr)
      el.height = Math.round(box.height * dpr)
      gl.viewport(0, 0, el.width, el.height)
      gl.uniform2f(u("uRes"), el.width, el.height)
      gl.uniform1f(u("uDpr"), dpr)
      // The contents' box, not the element's: a block stretched across the column would clear a band
      // of sky far wider than its words.
      const text = clear.map((node) => {
        range.selectNodeContents(node)
        return range.getBoundingClientRect()
      })
      const rects = new Float32Array(MAX_CLEAR * 4)
      clearBoxes(text).forEach((b, i) => rects.set(toShader(b, box, dpr), i * 4))
      gl.uniform4fv(u("uClear"), rects)
      gl.uniform1i(u("uClearN"), Math.min(clear.length, MAX_CLEAR))
      gl.uniform1f(u("uFeather"), CLEAR_FEATHER * dpr)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(el)
    clear.forEach((node) => observer.observe(node))
    void document.fonts.ready.then(draw)
    el.dataset.ready = "1"
    return () => observer.disconnect()
  }, [])

  return <canvas ref={canvas} aria-hidden className={className} />
}
