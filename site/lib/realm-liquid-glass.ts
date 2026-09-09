import { clock, effect, frame, frameLoop, init, sampler, surface, target, type Target } from "vgpu"

/**
 * vGPU's liquid-glass example (vgpu.sh/examples/typegpu-liquid-glass) with Realm's mark as the
 * refractive field and Realm's palette as the light. The passes and the maths are the example's,
 * written out as WGSL because the original's `"use gpu"` functions need TypeGPU's build plugin,
 * which this site does not run.
 *
 * Pipeline, run once at setup: bake the mark's signed distance field into a texture, take its
 * gradient, blur that gradient sixteen times so the refraction normal is smooth. Every frame then
 * draws one fullscreen pass that samples both.
 */

const FIELD_SIZE = 1024

/**
 * The faces of public/realm-mark.svg, flattened to polygons (each rounded corner became three
 * points). The mark's viewBox is 40 × 48, so these are in that space; the union of the six is the
 * mark's field, and their shared edges are where the glass changes facet.
 */
const FACES: readonly (readonly [number, number][])[] = [
  [[9.725, 41.798], [28.221, 41.798], [29.444, 41.582], [30.504, 40.969], [31.303, 40.018], [35.413, 32.899], [14.865, 32.899]],
  [[25.145, 15.101], [4.588, 15.101], [8.698, 7.982], [9.497, 7.032], [10.558, 6.419], [11.781, 6.203], [30.277, 6.203]],
  [[39.527, 25.78], [39.951, 24.612], [39.951, 23.388], [39.527, 22.221], [35.417, 15.101], [30.279, 24], [9.729, 24], [14.866, 32.899], [35.414, 32.899]],
  [[14.863, 32.899], [9.726, 24], [4.588, 32.899], [9.726, 41.798]],
  [[25.145, 15.101], [4.589, 15.101], [0.48, 22.221], [0.057, 23.388], [0.057, 24.612], [0.481, 25.78], [4.592, 32.899], [9.73, 24], [30.28, 24]],
  [[35.418, 15.101], [30.28, 6.203], [25.143, 15.101], [30.28, 24]],
]

/** Mark units per unit of field space; 20 puts the 40-wide mark exactly across the field's -1..1. */
const MARK_SCALE = 20
const MARK_CENTER: readonly [number, number] = [20, 24]

/** Realm's tokens as the shader sees them. sRGB-encoded, since the surface is not an sRGB view. */
const PAGE = [0.0906, 0.0943, 0.1017] as const
const INK = [0.9489, 0.9535, 0.958] as const
const ACCENT = [0.238, 0.6036, 1] as const
const ACCENT_INK = [0.4933, 0.7529, 1] as const

const TONEMAP = 1.35

/**
 * The ground has to come out of the tonemap as exactly `--color-page`, or the canvas reads as a
 * rectangle against the body. Solve the tonemap backwards for the value that gets there.
 */
const BASE = PAGE.map((channel) => -Math.log(1 - channel) / TONEMAP)

const vec3 = (rgb: readonly number[], scale = 1) =>
  `vec3f(${rgb.map((channel) => (channel * scale).toFixed(4)).join(", ")})`

const faceSdf = (index: number, vertices: readonly (readonly [number, number])[]) => {
  const count = vertices.length
  const literal = vertices.map(([x, y]) => `vec2f(${x}, ${y})`).join(", ")
  return /* wgsl */ `
fn face${index}(p: vec2f) -> f32 {
  var v = array<vec2f, ${count}>(${literal});
  var distanceSquared = dot(p - v[0], p - v[0]);
  var sign = 1.0;
  for (var i = 0u; i < ${count}u; i++) {
    let j = (i + ${count}u - 1u) % ${count}u;
    let edge = v[i] - v[j];
    let toPoint = p - v[j];
    let projection = saturate(dot(toPoint, edge) / dot(edge, edge));
    let delta = toPoint - edge * projection;
    distanceSquared = min(distanceSquared, dot(delta, delta));
    let crosses =
      (p.y >= v[j].y && p.y < v[i].y && edge.x * toPoint.y > edge.y * toPoint.x) ||
      (p.y < v[j].y && p.y >= v[i].y && edge.x * toPoint.y <= edge.y * toPoint.x);
    if (crosses) { sign = -sign; }
  }
  return sign * sqrt(distanceSquared);
}`
}

const sdfBakeShader = /* wgsl */ `
${FACES.map((vertices, index) => faceSdf(index, vertices)).join("\n")}

fn logoSdf(point: vec2f) -> f32 {
  let p = point * ${MARK_SCALE}.0 + vec2f(${MARK_CENTER[0]}.0, ${MARK_CENTER[1]}.0);
  var distance = face0(p);
  ${FACES.slice(1).map((_, index) => `distance = min(distance, face${index + 1}(p));`).join("\n  ")}
  return distance / ${MARK_SCALE}.0;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let point = uv * 2.0 - 1.0;
  return vec4f(logoSdf(point * 1.2), 0.0, 0.0, 1.0);
}
`

const gradientShader = /* wgsl */ `
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var fieldSampler: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let sample = textureSampleLevel(sourceTexture, fieldSampler, uv, 0.0).x;
  let derivative = vec2f(dpdx(sample), dpdy(sample));
  let magnitude = length(derivative);
  let normal = derivative / max(magnitude, 0.000001);
  return vec4f(normal * 0.5 + 0.5, magnitude, 1.0);
}
`

const blurShader = (direction: readonly [number, number]) => /* wgsl */ `
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var fieldSampler: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let offset = vec2f(${direction[0]}.0, ${direction[1]}.0) / ${FIELD_SIZE}.0;
  var value = textureSampleLevel(sourceTexture, fieldSampler, uv, 0.0) * 0.227027;
  value += textureSampleLevel(sourceTexture, fieldSampler, uv + offset * 1.384615, 0.0) * 0.316216;
  value += textureSampleLevel(sourceTexture, fieldSampler, uv - offset * 1.384615, 0.0) * 0.316216;
  value += textureSampleLevel(sourceTexture, fieldSampler, uv + offset * 3.230769, 0.0) * 0.07027;
  value += textureSampleLevel(sourceTexture, fieldSampler, uv - offset * 3.230769, 0.0) * 0.07027;
  return value;
}
`

const liquidGlassShader = /* wgsl */ `
struct Params { time: f32, aspect: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var sdfTexture: texture_2d<f32>;
@group(0) @binding(2) var gradientTexture: texture_2d<f32>;
@group(0) @binding(3) var fieldSampler: sampler;

fn lightStreams(point: vec2f, seconds: f32) -> vec3f {
  let direction = normalize(vec2f(0.7071 + sin(seconds) * 5.0, -0.7071));
  let normal = vec2f(0.7071, 0.7071);
  let along = dot(point, direction);
  let across = dot(point, normal);
  let convergence = smoothstep(-0.55, 0.38, along);
  let pulse = 0.76 + 0.24 * sin(seconds * 2.2 - along * 7.5);
  let shimmer = 0.82 + 0.18 * sin(seconds * 4.1 + along * 14.0 + across * 5.0);
  var color = vec3f(0.0);

  let split = 0.15;

  let accentCenter = -split * (1.0 - convergence) + 0.01 * sin(along * 8.0 - seconds * 1.7);
  let silverCenter = 0.01 * sin(along * 9.0 + seconds * 1.3);
  let skyCenter = split * (1.0 - convergence) + 0.01 * sin(along * 7.0 + seconds * 1.9);
  let width = mix(0.045, 0.075, convergence);
  let accent = exp(-pow(abs(across - accentCenter) / width, 1.65));
  let silver = exp(-pow(abs(across - silverCenter) / width, 1.65));
  let sky = exp(-pow(abs(across - skyCenter) / width, 1.65));

  let accentc = ${vec3(ACCENT)} * accent;
  let silverc = ${vec3(INK, 0.28)} * silver;
  let skyc = ${vec3(ACCENT_INK)} * sky;

  color += (accentc + silverc + skyc) * pulse * shimmer;

  let mergedWidth = 0.06 + 0.035 * convergence;
  let merged = exp(-pow(abs(across) / mergedWidth, 1.45)) * convergence;
  color += ${vec3(INK)} * merged * (1.15 + 0.35 * sin(seconds * 2.7 - along * 9.0));
  let halo = exp(-abs(across) * 7.5) * (0.16 + 0.22 * convergence);
  return color + ${vec3(ACCENT, 0.5)} * halo;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let seconds = params.time;
  let p = (uv - 0.5) * 2.0 * vec2f(params.aspect, 1.0);
  // The mark is wider than the example's, so on a portrait viewport the field shrinks with the
  // aspect instead of running off both edges.
  let fieldScale = 0.56 * min(1.0, params.aspect / 0.8);
  let fieldUv = p / fieldScale * 0.5 + 0.5;
  let distance = textureSampleLevel(sdfTexture, fieldSampler, fieldUv, 0.0).x * fieldScale;
  let smoothedDerivative = textureSampleLevel(gradientTexture, fieldSampler, fieldUv, 0.0);
  let pixelWidth = fwidth(distance);
  let logoMask = smoothstep(pixelWidth, -pixelWidth, distance);

  let decodedGradient = smoothedDerivative.rg * 2.0 - 1.0;
  let glassNormal = decodedGradient / max(length(decodedGradient), 0.0001);
  let ripple = sin(p.y * 16.0 - seconds * 2.5) * sin(p.x * 11.0 + seconds * 1.8);
  let warpedPoint = p + glassNormal * (0.055 + ripple * 0.014) * logoMask;

  let streams = lightStreams(p, seconds);
  let refracted = lightStreams(warpedPoint * 1.06 - vec2f(0.025, -0.015), seconds + 0.18);
  var color = ${vec3(BASE)};
  color += streams * 0.2;
  color = mix(color, refracted * 1.08 + color * 0.25, logoMask);

  let innerGlow = exp(-abs(distance) * 24.0) * logoMask;
  let rim = exp(-abs(distance) * 95.0);
  let specular = pow(max(dot(glassNormal, vec2f(-0.62, -0.78)), 0.0), 9.0) * rim;
  let shadow = smoothstep(0.09, 0.0, distance) * (1.0 - logoMask);
  color *= 1.0 - shadow * 0.42;
  color += ${vec3(ACCENT, 0.55)} * innerGlow * 0.22;
  color += ${vec3(ACCENT_INK)} * rim * 0.32;
  color += ${vec3(INK)} * specular * 1.2;
  color = vec3f(1.0) - exp(-color * ${TONEMAP}); // tonemapping

  return vec4f(color, 1.0);
}
`

function destroyTarget(value: Target) {
  ;(value as { destroy?: () => void }).destroy?.()
}

export async function createRealmLiquidGlass(canvas: HTMLCanvasElement, reduceMotion: boolean, signal?: AbortSignal) {
  const gpu = await init({ label: "realm-liquid-glass" })
  if (signal?.aborted) {
    gpu.dispose()
    throw new DOMException("Realm liquid glass setup was cancelled", "AbortError")
  }

  const fieldTarget = (label: string) =>
    target(gpu, { size: [FIELD_SIZE, FIELD_SIZE], format: "rgba16float", label })
  const sdfField = fieldTarget("realm-sdf-field")
  const rawGradient = fieldTarget("realm-sdf-gradient")
  const blurA = fieldTarget("realm-sdf-blur-a")
  const blurB = fieldTarget("realm-sdf-blur-b")
  const fieldSampler = sampler(gpu, {
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  })

  effect(gpu, sdfBakeShader, { label: "realm-sdf-bake" }).draw(sdfField)
  effect(gpu, gradientShader, {
    label: "realm-sdf-gradient",
    set: { sourceTexture: sdfField, fieldSampler },
  }).draw(rawGradient)
  const blurPasses = 16
  for (let index = 0; index < blurPasses; index += 1) {
    effect(gpu, blurShader([1, 0]), {
      label: `realm-sdf-blur-horizontal-${index}`,
      set: { sourceTexture: index === 0 ? rawGradient : blurB, fieldSampler },
    }).draw(blurA)
    effect(gpu, blurShader([0, 1]), {
      label: `realm-sdf-blur-vertical-${index}`,
      set: { sourceTexture: blurA, fieldSampler },
    }).draw(blurB)
  }

  const output = surface(gpu, canvas, { dpr: [1, 2], clearColor: [...PAGE, 1] })
  const shader = effect(gpu, liquidGlassShader, {
    label: "realm-liquid-glass",
    set: { params: { time: 0, aspect: 1 }, sdfTexture: sdfField, gradientTexture: blurB, fieldSampler },
  })
  const timeline = clock(gpu)
  let loop: { stop(): void } | undefined
  const setParams = () => {
    const width = Math.max(output.size[0], 1)
    const height = Math.max(output.size[1], 1)
    shader.set({ params: { time: reduceMotion ? 0 : timeline.time, aspect: width / height } })
  }
  const start = () => {
    if (loop) return
    loop = frameLoop(gpu, (frame) => {
      setParams()
      frame.pass(output, shader)
    })
  }
  const stop = () => {
    loop?.stop()
    loop = undefined
  }
  const unResize = output.onResize(setParams)
  // One frame is enough when motion is off: the field at time zero, then quiet.
  if (reduceMotion) frame(gpu, (still) => { setParams(); still.pass(output, shader) })
  else start()

  return {
    start,
    stop,
    dispose() {
      stop()
      unResize()
      ;[blurB, blurA, rawGradient, sdfField].forEach(destroyTarget)
      gpu.dispose()
    },
  }
}
