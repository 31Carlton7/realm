/**
 * A moving background, drawn on the GPU one frame at a time: the loop's frame printed as the still
 * is (the colour-kept screen, or as it is), and kept readable on every frame by the same rule as the
 * still. Behind an empty session the words are cleared by taking each pixel under them toward the
 * ground only as far as their inks need (hush, chat-backdrop.ts), feathered out round them, and the
 * picture feathers out round the prompter's card. Behind a transcript the frame is softened by the
 * edge blur's deeper radius and every pixel is hushed, as the chat's still is.
 *
 * The still does this on the CPU once, in about 55 ms; a loop has 42 ms a frame and the main thread
 * is the transcript's. Here it is one upload of the video's frame and two or three fragment passes.
 * The hush in `FRAG_HUSH` is hush()'s search step for step, so a frame and the still agree on what
 * reads; `hushPixel` is the same function in JS, for the test that holds them together.
 */
import type { Rect, Rgb } from "./hero-backdrop";
import { COLOR_LOOKS, HUSH_REACH } from "./hero-backdrop-color";

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

/** hush() in GLSL: the luminance it measures and the eight halvings of the share of the pixel kept. */
const FRAG_HUSH = `
uniform vec3 u_ground;
uniform float u_lo, u_hi;
float lin(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float lum(vec3 c) { return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b); }
bool fits(vec3 c) { float l = lum(c); return l >= u_lo && l <= u_hi; }
vec3 hush(vec3 p) {
  if (fits(p)) return p;
  float keep = 0.0, miss = 1.0;
  for (int i = 0; i < 8; i++) {
    float a = (keep + miss) * 0.5;
    if (fits(u_ground + (p - u_ground) * a)) keep = a; else miss = a;
  }
  return u_ground + (p - u_ground) * keep;
}`;

/** Where a canvas pixel (top-left origin) lands on the frame, laid as coverFit lays the still:
 *  across the middle, from the top. */
const FRAG_COVER = `
uniform sampler2D u_src;
uniform vec2 u_res, u_srcSize;
vec2 coverUv(vec2 frag) {
  float scale = max(u_res.x / u_srcSize.x, u_res.y / u_srcSize.y);
  vec2 origin = vec2((u_res.x - u_srcSize.x * scale) * 0.5, 0.0);
  return (frag - origin) / (u_srcSize * scale);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }`;

/** The empty session's frame: the screen per cell (ditherColor), the hush under the words and the
 *  feather round the card, premultiplied over a clear canvas as the still's mask is. */
const FRAG_HERO = `#version 300 es
precision highp float;
${FRAG_HUSH}
${FRAG_COVER}
uniform float u_cell, u_depth, u_dpr, u_feather, u_reach;
uniform vec4 u_card, u_words;
out vec4 o;
const float BAYER4[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
float outside(vec2 p, vec4 box, float r) {
  vec2 q = abs(p - (box.xy + box.zw * 0.5)) - box.zw * 0.5 + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec2 cell = floor(frag / u_cell);
  vec3 c = texture(u_src, coverUv((cell + 0.5) * u_cell)).rgb;
  if (u_depth > 0.0) {
    float cover = 0.04 + 0.6 * pow(1.0 - luma(c), 1.4);
    int k = int(mod(cell.y, 4.0)) * 4 + int(mod(cell.x, 4.0));
    if ((BAYER4[k] + 0.5) / 16.0 < cover) c *= 1.0 - u_depth;
  }
  vec2 css = frag / u_dpr;
  if (u_words.z > 0.0) c = mix(c, hush(c), 1.0 - smoothstep(0.0, u_reach, outside(css, u_words, min(u_words.w * 0.5, 24.0))));
  float a = u_card.z > 0.0 ? smoothstep(0.0, u_feather, outside(css, u_card, 16.0)) : 1.0;
  o = vec4(c * a, a);
}`;

/** The chat's first pass: the frame at the canvas's size, with the screen as the blur after it will
 *  see it, each cell's share of darkened dots averaged in. */
const FRAG_PRINT = `#version 300 es
precision highp float;
${FRAG_COVER}
uniform float u_depth;
out vec4 o;
void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec3 c = texture(u_src, coverUv(frag)).rgb;
  c *= 1.0 - u_depth * (0.04 + 0.6 * pow(1.0 - luma(c), 1.4));
  o = vec4(c, 1.0);
}`;

/** One direction of a Gaussian blur; the last pass hushes what it blurred. */
const MAX_TAPS = 24;
const fragBlur = (last: boolean) => `#version 300 es
precision highp float;
${FRAG_HUSH}
uniform sampler2D u_src;
uniform vec2 u_step;
uniform int u_taps;
uniform float u_weights[${MAX_TAPS + 1}];
out vec4 o;
void main() {
  vec2 size = vec2(textureSize(u_src, 0));
  vec2 uv = gl_FragCoord.xy / size;
  vec3 c = texture(u_src, uv).rgb * u_weights[0];
  for (int i = 1; i <= ${MAX_TAPS}; i++) {
    if (i > u_taps) break;
    vec2 d = u_step * float(i) / size;
    c += (texture(u_src, uv + d).rgb + texture(u_src, uv - d).rgb) * u_weights[i];
  }
  o = vec4(${last ? "hush(c)" : "c"}, 1.0);
}`;

/** The weights of a Gaussian of standard deviation `sigma` (CSS `blur()`'s radius), centre first,
 *  out to three sigma and summing to 1 over both sides. */
export function gaussian(sigma: number): number[] {
  if (sigma <= 0) return [1];
  const taps = Math.min(MAX_TAPS, Math.ceil(sigma * 3));
  const w = Array.from({ length: taps + 1 }, (_, i) => Math.exp(-(i * i) / (2 * sigma * sigma)));
  const sum = w[0]! + 2 * w.slice(1).reduce((a, b) => a + b, 0);
  return w.map((v) => v / sum);
}

const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** FRAG_HUSH's hush() for one pixel, written as the shader is, in single precision. */
export function hushPixel(p: Rgb, ground: Rgb, lo: number, hi: number): Rgb {
  const f = Math.fround;
  const fits = (c: Rgb) => { const l = f(lum(c)); return l >= f(lo) && l <= f(hi); };
  const at = (a: number): Rgb => [0, 1, 2].map((k) => f(ground[k]! + f(f(p[k]! - ground[k]!) * a))) as Rgb;
  if (fits(p)) return p;
  let keep = 0, miss = 1;
  for (let i = 0; i < 8; i++) {
    const a = f((keep + miss) * 0.5);
    if (fits(at(a))) keep = a; else miss = a;
  }
  return at(keep);
}

/** What one frame is drawn with. Rects are in the pane's CSS px; an empty one is none. */
export type LoopUniforms = {
  ground: Rgb;
  range: [number, number];
  /** How much darker a screened cell is (COLOR_LOOKS), 0 for a picture shown as it is. */
  depth: number;
  dpr: number;
  /** The empty session's: the prompter's card the picture feathers out round, and the box round
   *  the words it is hushed under. */
  card?: Rect;
  words?: Rect;
  /** The chat's: the blur's standard deviation in canvas px. */
  sigma?: number;
};

type Pass = { prog: WebGLProgram; loc: Map<string, WebGLUniformLocation | null> };

/** One canvas's GL: `hero` draws the empty session's frame at device px, `chat` the transcript's at
 *  the canvas's own (coarser) size through two FBOs. */
export class LoopRenderer {
  private gl: WebGL2RenderingContext;
  private passes: Record<string, Pass> = {};
  private src: WebGLTexture;
  private fbos: { fb: WebGLFramebuffer; tex: WebGLTexture }[] = [];
  private fboSize = [0, 0];

  constructor(private canvas: HTMLCanvasElement, private mode: "hero" | "chat") {
    if (typeof WebGL2RenderingContext === "undefined") throw new Error("webgl2 unavailable");
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("webgl2 unavailable");
    this.gl = gl;
    const sources = mode === "hero" ? { hero: FRAG_HERO } : { print: FRAG_PRINT, blurX: fragBlur(false), blurY: fragBlur(true) };
    for (const [name, frag] of Object.entries(sources)) this.passes[name] = this.program(frag);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.src = this.texture();
  }

  private program(frag: string): Pass {
    const gl = this.gl;
    const shader = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(prog, 0, "a_pos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    return { prog, loc: new Map() };
  }

  private texture() {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private use(name: string) {
    const pass = this.passes[name]!;
    this.gl.useProgram(pass.prog);
    const gl = this.gl;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    return (u: string) => {
      if (!pass.loc.has(u)) pass.loc.set(u, gl.getUniformLocation(pass.prog, u));
      return pass.loc.get(u) ?? null;
    };
  }

  /** The two FBOs the chat blurs through, at the canvas's size, made again only when it changes. */
  private targets(w: number, h: number) {
    const gl = this.gl;
    if (this.fboSize[0] === w && this.fboSize[1] === h) return this.fbos;
    for (const t of this.fbos) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
    this.fbos = [0, 1].map(() => {
      const tex = this.texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { fb, tex };
    });
    this.fboSize = [w, h];
    return this.fbos;
  }

  /** Draws `frame` (`fw`×`fh`) at the canvas's current size. */
  draw(frame: TexImageSource, fw: number, fh: number, u: LoopUniforms) {
    const gl = this.gl;
    const { width: w, height: h } = this.canvas;
    // The chat's FBOs first: making them binds their textures, which would leave the frame unbound.
    const fbos = this.mode === "chat" ? this.targets(w, h) : [];
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, frame);
    const hush = (loc: (n: string) => WebGLUniformLocation | null) => {
      gl.uniform3fv(loc("u_ground"), u.ground);
      gl.uniform1f(loc("u_lo"), u.range[0]);
      gl.uniform1f(loc("u_hi"), u.range[1]);
    };
    const cover = (loc: (n: string) => WebGLUniformLocation | null) => {
      gl.uniform1i(loc("u_src"), 0);
      gl.uniform2f(loc("u_res"), w, h);
      gl.uniform2f(loc("u_srcSize"), fw, fh);
    };
    if (this.mode === "hero") {
      const loc = this.use("hero");
      cover(loc);
      hush(loc);
      const rect = (r?: Rect): [number, number, number, number] => (r ? [r.x, r.y, r.w, r.h] : [0, 0, 0, 0]);
      gl.uniform1f(loc("u_cell"), Math.max(1, COLOR_LOOKS["dither-color"].cell));
      gl.uniform1f(loc("u_depth"), u.depth);
      gl.uniform1f(loc("u_dpr"), u.dpr);
      gl.uniform1f(loc("u_feather"), COLOR_LOOKS["dither-color"].feather);
      gl.uniform1f(loc("u_reach"), HUSH_REACH);
      gl.uniform4f(loc("u_card"), ...rect(u.card));
      gl.uniform4f(loc("u_words"), ...rect(u.words));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return;
    }
    const [a, b] = fbos;
    gl.viewport(0, 0, w, h);
    let loc = this.use("print");
    cover(loc);
    gl.uniform1f(loc("u_depth"), u.depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, a!.fb);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const weights = gaussian(u.sigma ?? 0);
    const blur = (pass: string, from: WebGLTexture, to: WebGLFramebuffer | null, step: [number, number]) => {
      loc = this.use(pass);
      hush(loc);
      gl.uniform1i(loc("u_src"), 0);
      gl.uniform2f(loc("u_step"), ...step);
      gl.uniform1i(loc("u_taps"), weights.length - 1);
      gl.uniform1fv(loc("u_weights[0]"), weights);
      gl.bindTexture(gl.TEXTURE_2D, from);
      gl.bindFramebuffer(gl.FRAMEBUFFER, to);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    blur("blurX", a!.tex, b!.fb, [1, 0]);
    blur("blurY", b!.tex, null, [0, 1]);
  }

  /** Waits for the GPU by reading a pixel back: for measuring a frame's cost only. */
  sync() { this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, new Uint8Array(4)); }

  /** The canvas's pixels, top row first: for a live check. */
  read(): Uint8ClampedArray {
    const { width: w, height: h } = this.canvas;
    const px = new Uint8Array(w * h * 4);
    this.gl.readPixels(0, 0, w, h, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
    const out = new Uint8ClampedArray(px.length);
    for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return out;
  }

  destroy() { this.gl.getExtension("WEBGL_lose_context")?.loseContext(); }
}

/** For a live check of the shader against hush(): `px` (RGBA, `w`×`h`, opaque) through the chat's
 *  passes with no blur and no screen, read back off the GPU. */
export function gpuHush(px: Uint8ClampedArray, w: number, h: number, ground: Rgb, range: [number, number]): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const r = new LoopRenderer(canvas, "chat");
  try {
    r.draw(new ImageData(new Uint8ClampedArray(px), w, h), w, h, { ground, range, depth: 0, dpr: 1, sigma: 0 });
    return r.read();
  } finally {
    r.destroy();
  }
}
