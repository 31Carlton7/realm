"""Source pictures for the new-session backdrops, drawn from noise so they can be redrawn and adjusted.

    python3 resources/hero-backdrops/make.py

Writes apps/desktop/src/renderer/src/assets/hero-backdrops/{haze,dunes,silk}.jpg at 1600x1000. Every
pixel comes from the seeded functions below: no photograph, nothing to license.
"""
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


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    haze(); dunes(); silk()
