/**
 * The picture behind an empty session: an image printed through an ordered dither in the theme's own
 * tones, drawn by one WebGL2 fragment pass.
 *
 * The image only lends its tonality (and, for some looks, a little of its hue): every colour on
 * screen is the theme's ground or a step off it toward its ink or accent, so a backdrop changes with
 * the face and the theme rather than standing on top of them. Around the greeting and the prompter
 * the dither thins out over a measured rect (the calm zone), so the words keep their contrast, and
 * the whole picture fades out toward the pane's foot.
 */

/** How one face prints the image. Coverage is the share of cells inked, mapped from luminance. */
type Face = {
  /** Coverage at the image's darkest and brightest (after `invert`). */
  lo: number; hi: number;
  /** Bright areas take ink (dark face) or dark areas do (light face). */
  invert: boolean;
  gamma: number;
  /** How far the ink tone stands from the ground, toward the theme's ink. */
  inkAmt: number;
  /** How much of the image's hue rides on both tones. */
  tint: number;
  /** How much of the picture itself shows as the ground, and scaled by what (darkens it for the dark face). */
  photo: number; photoGain: number;
  /** How much of the dither is taken away inside the calm zone (1 = plain ground). */
  calm: number;
};

/** One of the two printed effects: a fine two-tone Bayer dither, or round halftone dots. */
export type Look = {
  /** CSS px per dither cell. */
  cell: number;
  /** 0: square cells on a Bayer 8×8; 1: round halftone dots on a 45° screen. */
  shape: 0 | 1;
  /** The accent laid over the brightest cells, 0 for none. */
  highlight: number;
  /** Noise displacement of the image, in its own UV units, and how fast it moves when it may. */
  flow: number; speed: number;
  light: Face; dark: Face;
};

export const LOOKS: Record<"dither" | "halftone", Look> = {
  dither: {
    cell: 1, shape: 0, highlight: 0, flow: 0.018, speed: 0.035,
    light: { lo: 0.08, hi: 0.95, invert: true, gamma: 1.1, inkAmt: 0.22, tint: 0.6, photo: 0.75, photoGain: 1, calm: 1 },
    dark: { lo: 0.05, hi: 0.8, invert: false, gamma: 1.3, inkAmt: 0.2, tint: 0.5, photo: 0.6, photoGain: 0.3, calm: 1 },
  },
  halftone: {
    cell: 6, shape: 1, highlight: 0.2, flow: 0.08, speed: 0.04,
    light: { lo: 0.02, hi: 0.8, invert: false, gamma: 1.2, inkAmt: 0.26, tint: 0, photo: 0, photoGain: 1, calm: 1 },
    dark: { lo: 0.02, hi: 0.85, invert: false, gamma: 1.2, inkAmt: 0.3, tint: 0, photo: 0, photoGain: 1, calm: 1 },
  },
};

const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_img;
uniform vec2 u_res, u_imgSize;
uniform float u_cell, u_time, u_flow;
uniform int u_shape;
uniform vec3 u_ground, u_ink, u_hi;
uniform float u_lo, u_hiCov, u_gamma, u_invert, u_inkAmt, u_tint, u_hiAmt, u_calmAmt, u_photo, u_photoGain;
uniform vec4 u_calm;
uniform float u_feather;
out vec4 o;

float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  // The cell this pixel belongs to, and where in it the pixel sits. The halftone screen is turned 45°.
  vec2 p = frag;
  mat2 turn = mat2(0.7071, -0.7071, 0.7071, 0.7071);
  if (u_shape == 1) p = turn * frag;
  vec2 id = floor(p / u_cell);
  vec2 local = p / u_cell - id - 0.5;
  vec2 center = (id + 0.5) * u_cell;
  if (u_shape == 1) center = transpose(turn) * center;

  // Cover-fit, zoomed a little so the flow never pulls an edge in.
  float scale = max(u_res.x / u_imgSize.x, u_res.y / u_imgSize.y) * 1.08;
  vec2 uv = (center - 0.5 * u_res) / (u_imgSize * scale) + 0.5;
  if (u_flow > 0.0) {
    vec2 q = uv * 1.6;
    vec2 d = vec2(vnoise(q + vec2(u_time, 0.0)), vnoise(q + vec2(3.7, -u_time))) - 0.5;
    uv += d * u_flow;
  }
  vec3 c = texture(u_img, uv).rgb;
  float l = pow(dot(c, vec3(0.2126, 0.7152, 0.0722)), u_gamma);
  float lit = l;
  if (u_invert > 0.5) l = 1.0 - l;

  // The calm zone: a rounded rect round the greeting and the prompter, feathered out.
  vec2 half_ = 0.5 * u_calm.zw;
  float rad = min(half_.x, half_.y);
  vec2 dq = abs(frag - (u_calm.xy + half_)) - half_ + rad;
  float dist = length(max(dq, 0.0)) + min(max(dq.x, dq.y), 0.0) - rad;
  float calm = (1.0 - smoothstep(0.0, u_feather, dist)) * u_calmAmt;
  float cov = mix(u_lo, u_hiCov, l) * (1.0 - calm);

  vec3 chroma = (c - vec3(dot(c, vec3(0.2126, 0.7152, 0.0722)))) * u_tint * (1.0 - calm);
  vec3 ground = mix(u_ground, c * u_photoGain, u_photo * (1.0 - calm)) + chroma;
  vec3 ink = mix(ground, u_ink, u_inkAmt);
  if (u_hiAmt > 0.0) ink = mix(ink, mix(u_ground, u_hi, u_inkAmt * 1.6), u_hiAmt * smoothstep(0.7, 0.95, lit) * (1.0 - calm));

  float on;
  if (u_shape == 1) {
    float r = sqrt(cov) * 0.62;
    float aa = 0.75 / u_cell;
    on = 1.0 - smoothstep(r - aa, r + aa, length(local));
  } else {
    on = step(bayer8(id), cov - 0.001);
  }
  vec3 col = mix(ground, ink, on);
  // Out toward the pane's foot, where the transcript will be read once there is one.
  float a = 1.0 - smoothstep(0.62, 0.98, frag.y / u_res.y);
  o = vec4(col * a, a);
}`;

export type Rgb = [number, number, number];

/** A CSS colour (the tokens are oklch) as sRGB 0–1, read back through a 2D canvas. */
export function resolveColor(css: string): Rgb {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return [0, 0, 0];
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  const [r = 0, gg = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
  return [r / 255, gg / 255, b / 255];
}

export type Palette = { ground: Rgb; ink: Rgb; accent: Rgb; dark: boolean };

export function readPalette(root: HTMLElement): Palette {
  const s = getComputedStyle(root);
  return {
    ground: resolveColor(s.getPropertyValue("--canvas")),
    ink: resolveColor(s.getPropertyValue("--ink")),
    accent: resolveColor(s.getPropertyValue("--accent")),
    dark: root.getAttribute("data-mode") !== "light",
  };
}

/** A rect in the canvas's CSS pixels, top-left origin. */
export type Rect = { x: number; y: number; w: number; h: number };

export class BackdropRenderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private imgSize: [number, number] = [1, 1];
  private loc = new Map<string, WebGLUniformLocation | null>();
  ready = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error("webgl2 unavailable");
    this.gl = gl;
    const shader = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const at = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture()!;
  }

  async load(url: string): Promise<void> {
    const img = new Image();
    img.src = url;
    await img.decode();
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    this.imgSize = [img.naturalWidth, img.naturalHeight];
    this.ready = true;
  }

  private u(name: string) {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.loc.get(name) ?? null;
  }

  /** One frame. `dpr` maps the look's CSS cell and the calm rect onto the canvas's pixels; `time` is
   *  in the look's own units, 0 for a look held still. */
  draw(look: Look, pal: Palette, calm: Rect, dpr: number, time: number) {
    if (!this.ready) return;
    const gl = this.gl;
    const face = pal.dark ? look.dark : look.light;
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.uniform2f(this.u("u_res"), width, height);
    gl.uniform2f(this.u("u_imgSize"), this.imgSize[0], this.imgSize[1]);
    gl.uniform1f(this.u("u_cell"), Math.max(1, Math.round(look.cell * dpr)));
    gl.uniform1i(this.u("u_shape"), look.shape);
    gl.uniform1f(this.u("u_time"), time);
    gl.uniform1f(this.u("u_flow"), look.flow);
    gl.uniform3fv(this.u("u_ground"), pal.ground);
    gl.uniform3fv(this.u("u_ink"), pal.ink);
    gl.uniform3fv(this.u("u_hi"), pal.accent);
    gl.uniform1f(this.u("u_lo"), face.lo);
    gl.uniform1f(this.u("u_hiCov"), face.hi);
    gl.uniform1f(this.u("u_gamma"), face.gamma);
    gl.uniform1f(this.u("u_invert"), face.invert ? 1 : 0);
    gl.uniform1f(this.u("u_inkAmt"), face.inkAmt);
    gl.uniform1f(this.u("u_tint"), face.tint);
    gl.uniform1f(this.u("u_photo"), face.photo);
    gl.uniform1f(this.u("u_photoGain"), face.photoGain);
    gl.uniform1f(this.u("u_hiAmt"), look.highlight);
    gl.uniform1f(this.u("u_calmAmt"), face.calm);
    gl.uniform4f(this.u("u_calm"), calm.x * dpr, calm.y * dpr, calm.w * dpr, calm.h * dpr);
    gl.uniform1f(this.u("u_feather"), 220 * dpr);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Blocks until the GPU has drawn, by reading a pixel back — for measuring a frame's cost only
   *  (`finish` returns at once in Chromium, whose GPU work runs in another process). */
  sync() { this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, new Uint8Array(4)); }

  destroy() { this.gl.getExtension("WEBGL_lose_context")?.loseContext(); }
}
