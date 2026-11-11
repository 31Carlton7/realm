"""Source pictures for the new-session backdrops, drawn from noise so they can be redrawn and adjusted.

    python3 resources/hero-backdrops/make.py

Writes apps/desktop/src/renderer/src/assets/hero-backdrops/{haze,dunes,silk,sky-day,sky-dusk}.jpg at
1600x1000; name some to redraw only those (`make.py sky`). Every pixel comes from the seeded functions
below: no photograph, nothing to license.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

W, H = 1600, 1000
OUT = Path(__file__).resolve().parents[2] / "apps/desktop/src/renderer/src/assets/hero-backdrops"


def value_noise(rng, w, h, cells):
    grid = rng.random((cells + 3, int(cells * h / w) + 3))
    img = Image.fromarray((grid * 255).astype(np.uint8).T)
    return np.asarray(img.resize((w, h), Image.BICUBIC), dtype=np.float32) / 255


def fbm(rng, w, h, base=4, octaves=6, gain=0.5):
    total, amp, norm = np.zeros((h, w), np.float32), 1.0, 0.0
    for o in range(octaves):
        total += amp * value_noise(rng, w, h, base * 2**o)
        norm += amp
        amp *= gain
    return total / norm


def save(name, rgb, blur=0):
    img = Image.fromarray(np.clip(rgb * 255, 0, 255).astype(np.uint8))
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    img.save(OUT / name, quality=90)


def haze():
    """A long-exposure sky over low hills: pale teal over a peach horizon, the sun behind cloud."""
    rng = np.random.default_rng(7)
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    v = y / H
    sky = np.stack([0.62 + 0.30 * v, 0.76 + 0.14 * v, 0.80 + 0.04 * v], -1)
    sun = np.exp(-(((x - W * 0.68) / 420) ** 2 + ((y - H * 0.58) / 260) ** 2))
    sky += sun[..., None] * np.array([0.30, 0.18, 0.06])
    cloud = fbm(rng, W, H, base=3, octaves=6)
    streak = np.asarray(Image.fromarray((cloud * 255).astype(np.uint8)).filter(ImageFilter.BoxBlur(0)).resize((W // 8, H)).resize((W, H), Image.BICUBIC), np.float32) / 255
    clouds = np.clip((streak - 0.42) * 2.4, 0, 1) * (1 - v) ** 0.6
    sky = sky * (1 - clouds[..., None] * 0.35) + clouds[..., None] * np.array([1.0, 0.97, 0.94]) * 0.35
    for i, (base, height, tone) in enumerate([(0.74, 0.08, 0.85), (0.83, 0.07, 0.75), (0.92, 0.05, 0.65)]):
        ridge = H * (base - height * fbm(rng, W, 1, base=3 + i * 2, octaves=4)[0])
        land = (y > ridge[None, :]).astype(np.float32)
        col = np.array([0.42, 0.55, 0.56]) * tone + np.array([0.25, 0.18, 0.12]) * (1 - tone)
        sky = sky * (1 - land[..., None]) + (sky * 0.6 + col * 0.4) * land[..., None]
    save("haze.jpg", np.clip(sky, 0, 1), blur=10)


def dunes():
    """Wind-laid sand: long soft ridges lit from the left, as a single tone."""
    rng = np.random.default_rng(11)
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    warp = fbm(rng, W, H, base=2, octaves=2)
    phase = (y / H) * 5 + warp * 3 + np.sin(x / W * 3.1) * 0.6
    ridge = 0.5 + 0.5 * np.sin(phase * np.pi)
    light = ridge ** 2.2 * (0.7 + 0.3 * fbm(rng, W, H, base=2, octaves=2))
    lum = np.clip(0.12 + 0.85 * light, 0, 1)
    save("dunes.jpg", np.repeat(lum[..., None], 3, -1), blur=12)


def silk():
    """Cloth folds: a few broad sine folds bent by noise, lit as satin."""
    rng = np.random.default_rng(23)
    y, x = np.mgrid[0:H, 0:W].astype(np.float32) / np.float32(W)
    n = fbm(rng, W, H, base=2, octaves=3)
    a = np.sin((x * 3.0 + y * 1.4 + n * 1.8) * np.pi * 2)
    b = np.sin((x * -1.2 + y * 2.6 + n * 1.2) * np.pi * 2 + 1.3)
    fold = a * 0.65 + b * 0.35
    lum = np.clip(0.5 + 0.5 * fold, 0, 1) ** 3
    save("silk.jpg", np.repeat(lum[..., None], 3, -1), blur=8)


def blur(a, sigma):
    """A gaussian blur of a float field (Pillow only blurs 8-bit images), through the FFT with a
    mirrored border so the edges don't wrap."""
    pad = int(sigma * 3)
    a = np.pad(a, [(pad, pad), (pad, pad)] + [(0, 0)] * (a.ndim - 2), mode="reflect")
    fy = np.fft.fftfreq(a.shape[0])[:, None]
    fx = np.fft.rfftfreq(a.shape[1])[None, :]
    k = np.exp(-2 * (np.pi * sigma) ** 2 * (fx**2 + fy**2))
    if a.ndim == 3:
        k = k[..., None]
    out = np.fft.irfft2(np.fft.rfft2(a, axes=(0, 1)) * k, s=a.shape[:2], axes=(0, 1))
    return out[pad:-pad, pad:-pad].astype(np.float32)


def smoothstep(e0, e1, v):
    t = np.clip((v - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def sample(tex, u, v):
    """`tex` read bilinearly at (u, v) in texels, wrapping round in both directions."""
    th, tw = tex.shape
    u0, v0 = np.floor(u).astype(int), np.floor(v).astype(int)
    fu, fv = u - u0, v - v0
    a, b = tex[v0 % th, u0 % tw], tex[v0 % th, (u0 + 1) % tw]
    c, d = tex[(v0 + 1) % th, u0 % tw], tex[(v0 + 1) % th, (u0 + 1) % tw]
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv


def cumulus(rng, x, y, r, depth, out, base=None, z=0.0):
    """A heap of puffs, each with smaller ones on the half of its rim above the cloud's flat base:
    three or four scales of billow, like a cauliflower. Appends (x, y, r, depth toward the viewer) to
    `out`, a child standing a little in front of its parent."""
    base = y + r * 0.55 if base is None else base
    out.append((x, y, r, z))
    if depth == 0:
        return
    for _ in range(int(rng.integers(5, 10)) if depth > 1 else int(rng.integers(3, 6))):
        ang = rng.uniform(-np.pi * 1.1, np.pi * 0.1)
        d = r * rng.uniform(0.75, 1.0)
        cx, cy = x + np.cos(ang) * d, y + np.sin(ang) * d
        if cy > base:
            continue
        cumulus(rng, cx, cy, r * rng.uniform(0.3, 0.6), depth - 1, out, base, z + r * rng.uniform(0.0, 0.5))


def billows(rgb, puffs, light, lit, warm, shade, deep, haze=0.0, horizon=None, erode=None):
    """Paints `puffs` (x, y, r, depth) as one cloud: each puff a sphere, the nearest one winning each
    pixel, so the outline is a run of crisp scallops. A puff is shaded by how far its surface turns
    to `light` (a 3D direction, x right, y down, z toward the viewer): `lit` where it faces it, through
    `warm` and `shade`, to `deep` where it turns away."""
    z = np.full((H, W), -1e9, np.float32)
    nx, ny, nz = (np.zeros((H, W), np.float32) for _ in range(3))
    cover = np.zeros((H, W), np.float32)
    for px, py, r, pz in puffs:
        x0, x1 = max(0, int(px - r * 1.2)), min(W, int(px + r * 1.2) + 1)
        y0, y1 = max(0, int(py - r * 1.2)), min(H, int(py + r * 1.2) + 1)
        if x0 >= x1 or y0 >= y1:
            continue
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        dx, dy = (xx - px) / r, (yy - py) / r
        d = np.sqrt(dx * dx + dy * dy)
        if erode is not None:
            d = d + (erode[y0:y1, x0:x1] - 0.5) * 0.35
        dome = np.sqrt(np.clip(1 - d * d, 0, 1))
        zz = pz + r * dome
        win = (d < 1) & (zz > z[y0:y1, x0:x1])
        z[y0:y1, x0:x1] = np.where(win, zz, z[y0:y1, x0:x1])
        nx[y0:y1, x0:x1] = np.where(win, dx, nx[y0:y1, x0:x1])
        ny[y0:y1, x0:x1] = np.where(win, dy, ny[y0:y1, x0:x1])
        nz[y0:y1, x0:x1] = np.where(win, dome, nz[y0:y1, x0:x1])
        cover[y0:y1, x0:x1] = np.maximum(cover[y0:y1, x0:x1], smoothstep(1.0, 0.9, d))
    lx, ly, lz = np.array(light, np.float32) / np.linalg.norm(light)
    t = 0.5 + 0.8 * (nx * lx + ny * ly + nz * lz)
    # Cloud between a puff and the light keeps the light off it: lit from above, the lower part of a
    # heap sits in its own shadow, and lit from below, the upper part.
    near = blur(cover, 40)
    if ly < 0:
        near = np.concatenate([near[:1].repeat(70, 0), near[:-70]])
    else:
        near = np.concatenate([near[70:], near[-1:].repeat(70, 0)])
    t = t - 0.3 * near
    # Banded like a painting rather than smooth like a render: the tone steps between four values,
    # with a short ramp at each step.
    q = t * 4
    t = np.clip((np.floor(q) + smoothstep(0.35, 0.65, q - np.floor(q))) / 4 * 0.75 + t * 0.25, 0, 1)[..., None]
    lit, warm, shade, deep = (np.array(c, np.float32) for c in (lit, warm, shade, deep))
    face = np.where(t < 0.35, deep + (shade - deep) * (t / 0.35),
           np.where(t < 0.68, shade + (warm - shade) * ((t - 0.35) / 0.33), warm + (lit - warm) * ((t - 0.68) / 0.32)))
    if horizon is not None and haze:
        face = face * (1 - haze) + np.array(horizon, np.float32) * haze
    a = cover[..., None]
    return rgb * (1 - a) + face * a


def cirrus(rng, vanish, reach):
    """Streaks drawn out from a point low in the sky, as high cloud looks in perspective: a noise
    texture laid in (angle, log distance) round `vanish`, long along the distance and tight across."""
    tex = fbm(rng, 1024, 128, base=140, octaves=3, gain=0.5)
    patch = fbm(rng, 512, 256, base=5, octaves=3)
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    dx, dy = x - vanish[0], y - vanish[1]
    ang = np.arctan2(dy, dx)
    rr = np.sqrt(dx * dx + dy * dy) + 1
    warp = sample(fbm(rng, 256, 256, base=4, octaves=3), x / 6, y / 6) - 0.5
    u = (ang / (2 * np.pi)) * 1024 * 2 + warp * 40
    v = np.log(rr) * 12 + warp * 4
    n = sample(tex, u, v)
    # Broken along their length, like paint dragged dry.
    gaps = sample(patch, u * 0.25, np.log(rr) * 90)
    streak = smoothstep(0.58, 0.63, n) * smoothstep(0.42, 0.55, gaps)
    up = smoothstep(vanish[1] - 20, vanish[1] - reach, y)
    near = smoothstep(80, 320, rr)
    return streak * up * near


def rays(rng, sun, length):
    """Soft shafts of light fanning out from the sun."""
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    dx, dy = x - sun[0], y - sun[1]
    ang = np.arctan2(dy, dx)
    rr = np.sqrt(dx * dx + dy * dy)
    tex = fbm(rng, 720, 4, base=60, octaves=3)[1]
    s = sample(tex[None, :].repeat(2, 0), (ang / (2 * np.pi) + 0.5) * 720, np.zeros_like(ang))
    return smoothstep(0.52, 0.75, s) * np.exp(-rr / length) * smoothstep(0, 120, rr)


def paint(rgb, radius=2):
    """A painted finish: a mode filter flattens small areas into strokes of one colour, and a short
    blur softens where the strokes meet."""
    img = Image.fromarray(np.clip(rgb * 255, 0, 255).astype(np.uint8))
    img = img.filter(ImageFilter.ModeFilter(radius * 2 + 1)).filter(ImageFilter.GaussianBlur(0.7))
    return np.asarray(img, np.float32) / 255


def sky(seed, top, mid, horizon, glow, lit, warm, shade, deep, streak, light, wisp=0.7, stars=0.0):
    """A painted sky in four layers, back to front: a gradient from `top` through `mid` to `horizon`
    with a glow round a sun low in the middle and shafts from it; cirrus fanned out above the sun; a
    low bank of small cloud along the horizon; and towers of cumulus up both sides with a few loose
    heaps between. Every cloud is lit from the sun: `lit` on the rims facing it, through `warm` and
    `shade`, to `deep` on the far side of `light`."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    v = (y / H)[..., None]
    sun = (W * 0.5, H * 0.66)
    top, mid, horizon = (np.array(c, np.float32) for c in (top, mid, horizon))
    rgb = np.where(v < 0.45, top + (mid - top) * smoothstep(0, 0.45, v), mid + (horizon - mid) * smoothstep(0.45, 0.8, v))
    d = np.sqrt(((x - sun[0]) / W) ** 2 + ((y - sun[1]) / H * 0.8) ** 2)[..., None]
    rgb = rgb + np.array(glow, np.float32) * np.exp(-((d / 0.32) ** 2))
    if stars:
        # Their own stream, so the dusk sky's clouds fall where the day sky's do.
        star = np.random.default_rng(seed + 1)
        s = (star.random((H, W)) > 0.9993).astype(np.float32) * (0.5 + 0.5 * star.random((H, W)))
        rgb = rgb + blur(s, 0.9)[..., None] * stars * 14 * (1 - v) ** 2
    rgb = rgb + np.array(glow, np.float32) * 0.25 * rays(rng, sun, W * 0.45)[..., None]

    c = cirrus(rng, (W * 0.5, H * 0.62), H * 0.5)[..., None]
    rgb = rgb * (1 - c * wisp) + np.array(streak, np.float32) * c * wisp

    erode = fbm(rng, W, H, base=60, octaves=3, gain=0.6)
    # The far bank: small heaps along the horizon, hazed toward it.
    far = []
    for i in range(26):
        fx = W * (i / 25 + rng.uniform(-0.02, 0.02))
        cumulus(rng, fx, H * rng.uniform(0.56, 0.64), W * rng.uniform(0.018, 0.03), 2, far)
    rgb = billows(rgb, far, light, lit, warm, shade, deep, haze=0.45, horizon=horizon, erode=erode)

    # The towers, a little in from each edge, and loose heaps in the upper sky.
    near = []
    for side in (-1, 1):
        for j in range(9):
            t = j / 8
            bulge = 4 * t * (1 - t)
            cx = W * 0.5 + side * W * (0.52 - 0.06 * bulge - rng.uniform(0, 0.05))
            cumulus(rng, cx, H * (0.02 + 0.62 * t), W * (0.085 - 0.04 * t) * rng.uniform(0.8, 1.2), 3, near)
    for hx, hy, hr in [(0.30, 0.17, 0.035), (0.40, 0.10, 0.028), (0.66, 0.15, 0.03), (0.75, 0.30, 0.022), (0.24, 0.36, 0.02)]:
        cumulus(rng, W * hx, H * hy, W * hr, 3, near)
    rgb = billows(rgb, near, light, lit, warm, shade, deep, erode=erode)
    return paint(np.clip(rgb, 0, 1))


def sky_day():
    """A pastel afternoon: deep cornflower overhead, paling to near white at the horizon, the clouds
    peach-white where the sun lands, pink across the middle and lavender underneath."""
    save("sky-day.jpg", sky(31, top=(0.30, 0.42, 0.88), mid=(0.55, 0.66, 0.96), horizon=(0.93, 0.92, 0.97),
                            glow=(0.10, 0.06, 0.02), lit=(1.0, 0.95, 0.86), warm=(0.98, 0.68, 0.78),
                            shade=(0.66, 0.56, 0.86), deep=(0.44, 0.44, 0.80), streak=(0.98, 0.80, 0.88),
                            light=(0.0, -0.75, 0.55)))


def sky_dusk():
    """The same sky after sunset: deep blue overhead into violet, the clouds caught pink and lilac from
    below by the last light, and a few stars."""
    save("sky-dusk.jpg", sky(31, top=(0.04, 0.06, 0.20), mid=(0.12, 0.12, 0.34), horizon=(0.32, 0.22, 0.46),
                             glow=(0.16, 0.06, 0.10), lit=(0.80, 0.54, 0.74), warm=(0.46, 0.34, 0.62),
                             shade=(0.24, 0.20, 0.46), deep=(0.10, 0.10, 0.28), streak=(0.66, 0.46, 0.72),
                             light=(0.35, 0.6, 0.3), wisp=0.4, stars=0.6))


DRAW = {"haze": [haze], "dunes": [dunes], "silk": [silk], "sky": [sky_day, sky_dusk]}

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name in sys.argv[1:] or DRAW:
        for draw in DRAW[name]:
            draw()
