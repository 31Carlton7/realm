#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

// The empty session's print (Backdrop.swift), the desktop's hero-backdrop shaders on a still: the
// two-tone Bayer dither (mode 0) or halftone dots on a 45° screen (1) in the face's tones, the
// colour-kept dither over 2 px cells (2), or the picture as it is (3). Last, every pixel is taken toward
// the ground only as far as its luminance must go to sit in `range`, where the transcript's inks read.

static float bayer2(float2 a) { a = floor(a); return fract(dot(a, float2(0.5, a.y * 0.75))); }
static float bayer4(float2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
static float bayer8(float2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

static float linear1(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
static float luminance(float3 c) { return 0.2126 * linear1(c.r) + 0.7152 * linear1(c.g) + 0.0722 * linear1(c.b); }
static float luma(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }

/// `tones` is the ground, the ink and the accent, three floats each. `face` is lo, hi, invert, gamma,
/// ink amount, tint, photo, photo gain, highlight and the colour-kept depth.
[[ stitchable ]] half4 realmPrint(float2 position, SwiftUI::Layer layer, float scale, float mode, float cell,
                                  device const float *tones, int toneCount, device const float *face, int faceCount, float2 range) {
    float3 ground = float3(tones[0], tones[1], tones[2]);
    float3 ink = float3(tones[3], tones[4], tones[5]);
    float3 accent = float3(tones[6], tones[7], tones[8]);
    float2 pixel = position * scale;
    float3 col;

    if (mode > 2.5) {
        col = float3(layer.sample(position).rgb);
    } else if (mode > 1.5) {
        // 2×2 device-pixel cells, each its colour at full strength or a step darker.
        float2 id = floor(pixel / 2.0);
        float3 c = float3(layer.sample((id * 2.0 + 1.0) / scale).rgb);
        float cover = 0.04 + 0.6 * pow(1.0 - luma(c), 1.4);
        int x = int(id.x) & 3, y = int(id.y) & 3;
        const int b4[16] = { 0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5 };
        col = (float(b4[y * 4 + x]) + 0.5) / 16.0 < cover ? c * (1.0 - face[9]) : c;
    } else {
        bool dots = mode > 0.5;
        float2x2 turn = float2x2(float2(0.7071, -0.7071), float2(0.7071, 0.7071));
        float2 p = dots ? turn * pixel : pixel;
        float2 id = floor(p / cell);
        float2 local = p / cell - id - 0.5;
        float2 center = (id + 0.5) * cell;
        if (dots) center = transpose(turn) * center;
        float3 c = float3(layer.sample(center / scale).rgb);
        float lit = pow(luma(c), face[3]);
        float l = face[2] > 0.5 ? 1.0 - lit : lit;
        float cover = mix(face[0], face[1], l);
        float3 chroma = (c - float3(luma(c))) * face[5];
        float3 g = mix(ground, c * face[7], face[6]) + chroma;
        float3 k = mix(g, ink, face[4]);
        if (face[8] > 0.0) k = mix(k, mix(ground, accent, face[4] * 1.6), face[8] * smoothstep(0.7, 0.95, lit));
        float on;
        if (dots) {
            float r = sqrt(cover) * 0.62;
            float aa = 0.75 / cell;
            on = 1.0 - smoothstep(r - aa, r + aa, length(local));
        } else {
            on = step(bayer8(id), cover - 0.001);
        }
        col = mix(g, k, on);
    }

    // The print can run past the screen's range (a hue's chroma over a bright photo); the guard
    // measures what will be shown.
    col = saturate(col);
    float lum = luminance(col);
    if (lum < range.x || lum > range.y) {
        float keep = 0.0, miss = 1.0;
        for (int i = 0; i < 10; i++) {
            float t = 0.5 * (keep + miss);
            float m = luminance(mix(ground, col, t));
            if (m >= range.x && m <= range.y) keep = t; else miss = t;
        }
        col = mix(ground, col, keep);
    }
    return half4(half3(col), 1.0h);
}
