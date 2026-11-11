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


def puffs(rng):
    """Where the cumulus sits: a bank heaped in each top corner and spilling down its side, a few
    smaller heaps between, and the middle of the sky left open. Each puff is (x, y, radius, lean,
    lift): `lean` is which way its light comes from (+1 from the right), `lift` how far into the light
    it stands, from 0 deep in a bank to 1 on its sunlit rim. Back to front."""
    out = []
    for side in (0, 1):
        # The bank's core: a few big puffs. Its rim: many small ones round the core's edge, toward the
        # open sky, which is the edge the light lands on.
        core = []
        for _ in range(9):
            t = rng.random()
            x, y = W * (0.02 + 0.16 * rng.random() * (1.2 - t)), H * (0.02 + 0.8 * t**1.3)
            r = W * (0.07 + 0.05 * rng.random()) * (1.1 - 0.5 * t)
            core.append((x, y, r))
            out.append((x, y, r, 0.15))
        for _ in range(160):
            cx, cy, cr = core[rng.integers(len(core))]
            ang = rng.uniform(-np.pi * 0.95, np.pi * 0.35)
            d = cr * rng.uniform(0.75, 1.15)
            x, y = cx + np.cos(ang) * d, cy + np.sin(ang) * d
            r = cr * rng.uniform(0.18, 0.45)
            lift = 0.5 + 0.5 * np.cos(ang + np.pi * 0.3)
            out.append((x, y, r, lift))
        if side:
            out[-169:] = [(W - x, y, r, lift) for x, y, r, lift in out[-169:]]
        out[-169:] = [(x, y, r, lift, -1 if side else 1) for x, y, r, lift in out[-169:]]
    for cx, cy, n, size in [(0.40, 0.20, 12, 0.016), (0.63, 0.13, 10, 0.014), (0.52, 0.50, 16, 0.02)]:
        for _ in range(n):
            x = W * (cx + (rng.random() - 0.5) * 0.12)
            out.append((x, H * (cy + (rng.random() - 0.5) * 0.05), W * size * (0.6 + rng.random()), 0.6, 1 if x < W / 2 else -1))
    out.sort(key=lambda p: p[1] - p[2] * 0.3)
    return out


def clouds(rng, rgb, lit, warm, shade):
    """Paints the puffs onto `rgb` one by one, back to front. A puff is a soft disc with a ragged
    edge, lit across its face: `lit` where it turns to the light, `warm` across the middle and `shade`
    on the side away from it, so heaped puffs read as one billowing cloud."""
    edge = fbm(rng, W, H, base=24, octaves=4, gain=0.6)
    grain = fbm(rng, W, H, base=60, octaves=3, gain=0.6)
    for px, py, r, lift, lean in puffs(rng):
        x0, x1 = max(0, int(px - r * 1.3)), min(W, int(px + r * 1.3))
        y0, y1 = max(0, int(py - r * 1.3)), min(H, int(py + r * 1.3))
        if x0 >= x1 or y0 >= y1:
            continue
        y, x = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        dx, dy = (x - px) / r, (y - py) / r
        dist = np.sqrt(dx * dx + dy * dy) + (edge[y0:y1, x0:x1] - 0.5) * 0.8
        a = smoothstep(1.0, 0.72, dist) * (0.85 + 0.15 * lift)
        # Light across the face from above and the open side, brighter for a puff out on the rim; the
        # underside of each stays in shade.
        face_t = 0.55 * (dx * 0.6 * lean - dy * 0.8) - 0.3 * np.clip(dy, 0, 1)
        t = np.clip(0.2 + 0.55 * lift + face_t + (grain[y0:y1, x0:x1] - 0.5) * 0.3 - 0.25 * (py / H), 0, 1)[..., None]
        face = np.where(t < 0.5, np.array(shade) * (1 - t * 2) + np.array(warm) * t * 2,
                        np.array(warm) * (2 - t * 2) + np.array(lit) * (t * 2 - 1))
        rgb[y0:y1, x0:x1] = rgb[y0:y1, x0:x1] * (1 - a[..., None]) + face * a[..., None]
    return rgb


def wisps(rng):
    """Thin streaks across the open middle, drawn long and flat like a brush dragged sideways."""
    n = fbm(rng, W // 10, H, base=4, octaves=5)
    n = np.asarray(Image.fromarray((n * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC), np.float32) / 255
    v = np.mgrid[0:H, 0:W][0].astype(np.float32) / H
    u = np.mgrid[0:H, 0:W][1].astype(np.float32) / W
    return smoothstep(0.5, 0.78, n) * np.exp(-(((v - 0.30 - 0.12 * np.abs(u - 0.5)) / 0.14) ** 2))


def paint(rgb, radius=3):
    """A painted finish: a mode filter flattens small areas into strokes of one colour, and a short
    blur softens where the strokes meet."""
    img = Image.fromarray(np.clip(rgb * 255, 0, 255).astype(np.uint8))
    img = img.filter(ImageFilter.ModeFilter(radius * 2 + 1)).filter(ImageFilter.GaussianBlur(1.2))
    return np.asarray(img, np.float32) / 255


def sky(name, seed, top, horizon, lit, warm, shade, stars=0.0):
    """A sky with banks of cumulus, lit from the upper right. `top` and `horizon` are the sky's
    gradient; a cloud's face runs from `shade` in its hollows through `warm` to `lit` where the light
    lands on it."""
    rng = np.random.default_rng(seed)
    v = np.mgrid[0:H, 0:W][0].astype(np.float32)[..., None] / H
    base = np.array(top) * (1 - v**0.8) + np.array(horizon) * v**0.8
    if stars:
        s = (rng.random((H, W)) > 0.9993).astype(np.float32) * rng.random((H, W))
        base = base + blur(s, 0.8)[..., None] * stars * 6 * (1 - v)
    out = np.ascontiguousarray(np.broadcast_to(base, (H, W, 3))).astype(np.float32)
    w = wisps(rng)[..., None]
    out = out * (1 - w * 0.75) + np.array(warm) * w * 0.75
    out = clouds(rng, out, lit, warm, shade)
    return paint(np.clip(out, 0, 1))



def sky_day():
    """A pastel afternoon: cornflower blue overhead, paling toward the horizon, pink and peach cloud."""
    save("sky-day.jpg", sky("day", 31, top=(0.42, 0.56, 0.94), horizon=(0.80, 0.84, 0.98),
                            lit=(1.0, 0.93, 0.84), warm=(0.98, 0.70, 0.80), shade=(0.56, 0.54, 0.86)))


def sky_dusk():
    """The same sky after sunset: deep blue overhead into violet, the clouds violet with a lilac rim
    where the last light catches them, and a few stars."""
    save("sky-dusk.jpg", sky("dusk", 31, top=(0.04, 0.07, 0.22), horizon=(0.17, 0.15, 0.38),
                             lit=(0.80, 0.58, 0.80), warm=(0.36, 0.30, 0.62), shade=(0.11, 0.12, 0.32), stars=0.6))


DRAW = {"haze": [haze], "dunes": [dunes], "silk": [silk], "sky": [sky_day, sky_dusk]}

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name in sys.argv[1:] or DRAW:
        for draw in DRAW[name]:
            draw()
