"""Source pictures for the new-session backdrops, drawn from noise so they can be redrawn and adjusted.

    python3 resources/hero-backdrops/make.py            # every look
    python3 resources/hero-backdrops/make.py ocean sky  # only these

Writes apps/desktop/src/renderer/src/assets/hero-backdrops/*.jpg at 2560x1600; gallery.json beside them
lists the looks. Every pixel comes from the seeded functions below, so a run redraws the same bytes:
no photograph, nothing to license.
"""
import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

W, H = 2560, 1600
S = W / 1600
OUT = Path(__file__).resolve().parents[2] / "apps/desktop/src/renderer/src/assets/hero-backdrops"
F = np.float32


# ---------------------------------------------------------------------------------------------------
# Noise, sampling and light


def value_noise(rng, w, h, cells):
    grid = rng.random((cells + 3, int(cells * h / w) + 3))
    img = Image.fromarray((grid * 255).astype(np.uint8).T)
    return np.asarray(img.resize((w, h), Image.BICUBIC), dtype=F) / 255


def fbm(rng, w, h, base=4, octaves=6, gain=0.5):
    total, amp, norm = np.zeros((h, w), F), 1.0, 0.0
    for o in range(octaves):
        total += amp * value_noise(rng, w, h, base * 2**o)
        norm += amp
        amp *= gain
    return total / norm


def noise(rng, h, w, beta=2.5, ax=1.0, ay=1.0, low=1.0):
    """Gaussian noise with a power-law spectrum, wrapping round in both directions: `beta` sets how
    much the large scales dominate, `ax`/`ay` stretch it (a large `ax` makes features long in x), and
    frequencies under `low` cycles per image are kept out. Mean 0, deviation 1."""
    spec = np.fft.rfft2(rng.standard_normal((h, w)).astype(F))
    fy = np.fft.fftfreq(h)[:, None] * h
    fx = np.fft.rfftfreq(w)[None, :] * w
    f = np.sqrt((fx * ax) ** 2 + (fy * ay) ** 2)
    f[0, 0] = 1
    amp = np.where(f < low, 0, f ** (-beta / 2))
    out = np.fft.irfft2(spec * amp, s=(h, w)).astype(F)
    return (out - out.mean()) / out.std()


def noise1d(rng, n, beta=2.0, low=1.0):
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.arange(spec.size, dtype=np.float64)
    f[0] = 1
    out = np.fft.irfft(spec * np.where(f < low, 0, f ** (-beta / 2)), n)
    return ((out - out.mean()) / out.std()).astype(F)


def blur(a, sigma):
    """A gaussian blur of a float field (Pillow only blurs 8-bit images), through the FFT with a
    mirrored border so the edges don't wrap."""
    if sigma <= 0:
        return a
    pad = int(sigma * 3) + 1
    a = np.pad(a, [(pad, pad), (pad, pad)] + [(0, 0)] * (a.ndim - 2), mode="reflect")
    fy = np.fft.fftfreq(a.shape[0])[:, None]
    fx = np.fft.rfftfreq(a.shape[1])[None, :]
    k = np.exp(-2 * (np.pi * sigma) ** 2 * (fx**2 + fy**2))
    if a.ndim == 3:
        k = k[..., None]
    out = np.fft.irfft2(np.fft.rfft2(a, axes=(0, 1)) * k, s=a.shape[:2], axes=(0, 1))
    return out[pad:-pad, pad:-pad].astype(F)


def blur_y(a, sigma):
    """A blur down the columns only: reflections on water are drawn out vertically."""
    pad = int(sigma * 3) + 1
    a = np.pad(a, [(pad, pad), (0, 0)] + [(0, 0)] * (a.ndim - 2), mode="reflect")
    fy = np.fft.rfftfreq(a.shape[0])
    k = np.exp(-2 * (np.pi * sigma) ** 2 * fy**2).reshape((-1,) + (1,) * (a.ndim - 1))
    out = np.fft.irfft(np.fft.rfft(a, axis=0) * k, n=a.shape[0], axis=0)
    return out[pad:-pad].astype(F)


def smoothstep(e0, e1, v):
    t = np.clip((v - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def sample(tex, u, v):
    """`tex` read bilinearly at (u, v) in texels, wrapping round in both directions. `tex` may carry a
    trailing channel axis."""
    th, tw = tex.shape[:2]
    u0, v0 = np.floor(u).astype(np.int32), np.floor(v).astype(np.int32)
    fu, fv = (u - u0).astype(F), (v - v0).astype(F)
    if tex.ndim == 3:
        fu, fv = fu[..., None], fv[..., None]
    x0, x1, y0, y1 = u0 % tw, (u0 + 1) % tw, v0 % th, (v0 + 1) % th
    a, b, c, d = tex[y0, x0], tex[y0, x1], tex[y1, x0], tex[y1, x1]
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv


def clamp_sample(tex, u, v):
    th, tw = tex.shape[:2]
    return sample(tex, np.clip(u, 0, tw - 1.001), np.clip(v, 0, th - 1.001))


def col(c):
    return np.array(c, F)


def ramp(t, stops):
    """Colour along `t` through `stops`, [(position, (r, g, b)), ...]."""
    pos = [p for p, _ in stops]
    cols = np.array([c for _, c in stops], F)
    flat = t.ravel()
    return np.stack([np.interp(flat, pos, cols[:, i]) for i in range(3)], -1).reshape(t.shape + (3,)).astype(F)


def grid():
    y, x = np.mgrid[0:H, 0:W].astype(F)
    return x, y


def splat(xs, ys, cols, h=H, w=W):
    """Point lights at subpixel positions, shared bilinearly between their four pixels."""
    img = np.zeros((h, w, 3), F)
    x0, y0 = np.floor(xs).astype(np.int64), np.floor(ys).astype(np.int64)
    fx, fy = (xs - x0)[:, None], (ys - y0)[:, None]
    for dx, dy, wt in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
        xx, yy = x0 + dx, y0 + dy
        ok = (xx >= 0) & (xx < w) & (yy >= 0) & (yy < h)
        np.add.at(img, (yy[ok], xx[ok]), (cols * wt)[ok])
    return img


def star_colours(rng, n):
    """Star colours by temperature: mostly white, some blue-white, fewer yellow and orange."""
    t = rng.beta(2.2, 2.2, n)
    return ramp(t, [(0, (0.62, 0.74, 1.0)), (0.35, (0.86, 0.9, 1.0)), (0.55, (1.0, 0.97, 0.92)),
                    (0.8, (1.0, 0.84, 0.62)), (1, (1.0, 0.66, 0.42))])


def starfield(rng, count, bright=1.0, weight=None):
    """A sky of stars at three depths: a dust of faint ones, a scatter of brighter, and a few with a
    soft halo. `weight` (H, W) thins them where it is low."""
    out = np.zeros((H, W, 3), F)
    for n, lo, hi, core, halo in ((count, 0.04, 0.25, 0.55, 0), (count // 12, 0.3, 1.2, 0.7, 0), (count // 160, 1.5, 4.0, 0.9, 5.0)):
        xs, ys = rng.uniform(0, W, n), rng.uniform(0, H, n)
        mag = np.exp(rng.uniform(np.log(lo), np.log(hi), n))
        if weight is not None:
            mag = mag * weight[np.clip(ys.astype(int), 0, H - 1), np.clip(xs.astype(int), 0, W - 1)]
        pts = splat(xs, ys, star_colours(rng, n) * mag[:, None] * bright)
        out += blur(pts, core) * (2 * np.pi * core * core) ** 0.5
        if halo:
            out += blur(pts, halo) * 6
    return out


def tonemap(lin, exposure=1.0):
    """Linear light to display: a soft shoulder so bright cores bloom instead of clipping, then sRGB."""
    v = 1 - np.exp(-np.maximum(lin, 0) * exposure)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055).astype(F)


def to_linear(c):
    c = np.asarray(c, F)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(F)


def bloom(lin, sigmas=((6, 0.25), (28, 0.18), (90, 0.10))):
    out = lin.copy()
    for s, wgt in sigmas:
        out += blur(lin, s * S) * wgt
    return out


BUDGET = 200_000


def save(name, rgb, blur_px=0, quality=85, subsampling=None):
    """Writes `rgb` as a JPEG, stepping the quality down from `quality` until it fits the app's
    per-picture budget (or reaches 70). The backdrop is printed through a dither of 2px cells or
    coarser, so the detail a lower quality loses never reaches the screen."""
    img = Image.fromarray(np.clip(rgb * 255 + 0.5, 0, 255).astype(np.uint8))
    if blur_px:
        img = img.filter(ImageFilter.GaussianBlur(blur_px))
    kw = {} if subsampling is None else {"subsampling": subsampling}
    for q in range(quality, 69, -3):
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=q, optimize=True, **kw)
        if buf.tell() <= BUDGET:
            break
    (OUT / name).write_bytes(buf.getvalue())


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------------------------------------------
# Haze, Dunes and Silk: the tonal looks printed in the theme's two tones.


def haze():
    """A long-exposure sky over low hills: pale teal over a peach horizon, the sun behind cloud."""
    rng = np.random.default_rng(7)
    y, x = np.mgrid[0:H, 0:W].astype(F)
    v = y / H
    sky = np.stack([0.62 + 0.30 * v, 0.76 + 0.14 * v, 0.80 + 0.04 * v], -1)
    sun = np.exp(-(((x - W * 0.68) / (420 * S)) ** 2 + ((y - H * 0.58) / (260 * S)) ** 2))
    sky += sun[..., None] * np.array([0.30, 0.18, 0.06])
    cloud = fbm(rng, W, H, base=3, octaves=6)
    streak = np.asarray(Image.fromarray((cloud * 255).astype(np.uint8)).resize((W // 8, H)).resize((W, H), Image.BICUBIC), F) / 255
    clouds = np.clip((streak - 0.42) * 2.4, 0, 1) * (1 - v) ** 0.6
    sky = sky * (1 - clouds[..., None] * 0.35) + clouds[..., None] * np.array([1.0, 0.97, 0.94]) * 0.35
    for i, (base, height, tone) in enumerate([(0.74, 0.08, 0.85), (0.83, 0.07, 0.75), (0.92, 0.05, 0.65)]):
        ridge = H * (base - height * fbm(rng, W, 1, base=3 + i * 2, octaves=4)[0])
        land = (y > ridge[None, :]).astype(F)
        c = np.array([0.42, 0.55, 0.56]) * tone + np.array([0.25, 0.18, 0.12]) * (1 - tone)
        sky = sky * (1 - land[..., None]) + (sky * 0.6 + c * 0.4) * land[..., None]
    save("haze.jpg", np.clip(sky, 0, 1), blur_px=10 * S)


def dunes():
    """Wind-laid sand: long soft ridges lit from the left, as a single tone."""
    rng = np.random.default_rng(11)
    y, x = np.mgrid[0:H, 0:W].astype(F)
    warp = fbm(rng, W, H, base=2, octaves=2)
    phase = (y / H) * 5 + warp * 3 + np.sin(x / W * 3.1) * 0.6
    ridge = 0.5 + 0.5 * np.sin(phase * np.pi)
    light = ridge ** 2.2 * (0.7 + 0.3 * fbm(rng, W, H, base=2, octaves=2))
    lum = np.clip(0.12 + 0.85 * light, 0, 1)
    save("dunes.jpg", np.repeat(lum[..., None], 3, -1), blur_px=12 * S)


def silk():
    """Cloth folds: a few broad sine folds bent by noise, lit as satin."""
    rng = np.random.default_rng(23)
    y, x = np.mgrid[0:H, 0:W].astype(F) / F(W)
    n = fbm(rng, W, H, base=2, octaves=3)
    a = np.sin((x * 3.0 + y * 1.4 + n * 1.8) * np.pi * 2)
    b = np.sin((x * -1.2 + y * 2.6 + n * 1.2) * np.pi * 2 + 1.3)
    fold = a * 0.65 + b * 0.35
    lum = np.clip(0.5 + 0.5 * fold, 0, 1) ** 3
    save("silk.jpg", np.repeat(lum[..., None], 3, -1), blur_px=8 * S)


# ---------------------------------------------------------------------------------------------------
# Helpers for the painted looks, which keep their own colours.


def L(c):
    """An sRGB colour (or image) as the linear light that `tonemap` turns back into it."""
    return -np.log(1 - np.clip(to_linear(c), 0, 0.995)).astype(F)


def blur_wrap(tex, sigma):
    """A gaussian blur of a texture that wraps round, so it still tiles."""
    fy = np.fft.fftfreq(tex.shape[0])[:, None]
    fx = np.fft.rfftfreq(tex.shape[1])[None, :]
    k = np.exp(-2 * (np.pi * sigma) ** 2 * (fx**2 + fy**2))
    return np.fft.irfft2(np.fft.rfft2(tex) * k, s=tex.shape).astype(F)


MIP = (0, 1, 2.5, 6, 14, 32)


def mips(tex):
    return [tex if s == 0 else blur_wrap(tex, s) for s in MIP]


def mip_sample(levels, u, v, footprint):
    """`levels` read at (u, v), softened to the texels one pixel covers so a texture laid in
    perspective doesn't sparkle where it recedes."""
    idx = np.interp(footprint * 0.45, MIP, np.arange(len(MIP))).astype(F)
    out = np.zeros(u.shape, F)
    for i, lvl in enumerate(levels):
        wgt = np.clip(1 - np.abs(idx - i), 0, 1)
        if wgt.max() > 0:
            out += sample(lvl, u, v) * wgt
    return out


def glow(x, y, cx, cy, scales):
    """Light round a point, as a sum of exponential falloffs [(radius in px, strength), ...]."""
    r = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
    return sum(np.exp(-r / (rad * S)) * k for rad, k in scales)


def ridge_line(rng, base, amp, beta=2.2, sharp=0.0):
    """A skyline along x, in px: `base` plus noise of height `amp`; `sharp` mixes in ridged noise for
    crisp peaks."""
    n = noise1d(rng, W * 2, beta, low=2)[:W]
    if sharp:
        r = 1 - np.abs(noise1d(rng, W * 2, beta - 0.3, low=3)[:W])
        n = n * (1 - sharp) + (r - r.mean()) / r.std() * sharp
    return (base - amp * n).astype(F)


def layer(rgb, ridge, colour, y, soft=1.0):
    """`colour` laid over everything below `ridge`, the edge antialiased."""
    a = np.clip((y - ridge[None, :]) / soft + 0.5, 0, 1)[..., None]
    return rgb * (1 - a) + colour * a, a[..., 0]


# ---------------------------------------------------------------------------------------------------
# Sky: soft cumulus over a plane in perspective, lit by marching toward the sun.


def sky(seed, top, mid, horizon, sun, sun_col, sun_glow, lit, shade, coverage, stars=0.0, disk=0.0):
    rng = np.random.default_rng(seed)
    x, y = grid()
    hy = H * 0.80
    base = ramp(y / H, [(0, top), (0.42, mid), (hy / H, horizon), (1, horizon)])
    rgb = L(base) + col(sun_glow) * glow(x, y, sun[0], sun[1], [(40, 1.4), (180, 0.5), (700, 0.25)])[..., None]
    if disk:
        r = np.sqrt((x - sun[0]) ** 2 + (y - sun[1]) ** 2)
        rgb += col(sun_col)[None, None] * smoothstep(20 * S, 17 * S, r)[..., None] * disk
    if stars:
        sr = np.random.default_rng(seed + 1)
        rgb += starfield(sr, 5000, stars, weight=smoothstep(hy, 0, y) ** 2)

    # The cloud deck: one tile of noise laid on a plane above the eye, receding to the horizon.
    tex = noise(rng, 1024, 1024, beta=3.0, ax=1.0, ay=1.0) * 0.8 + noise(rng, 1024, 1024, beta=1.8) * 0.2
    warp = noise(rng, 1024, 1024, beta=3.2)
    lv, wv = mips(tex), mips(warp)
    d = np.maximum(hy - y, 1)
    K = 0.30 * hy
    X = (x - W * 0.5) * K / d + 300
    Z = K * hy * 1.25 / d
    fp = np.maximum(K / d, K * hy * 1.25 / d**2)
    wq = mip_sample(wv, X * 0.5, Z * 0.5, fp * 0.5)
    n = mip_sample(lv, X + wq * 40, Z + wq * 25, fp)
    dens = smoothstep(coverage, coverage + 1.1, n) * smoothstep(0, 30 * S, d)
    dens = blur(dens, 1.2 * S)

    # Light reaching each point: cloud between it and the sun takes it away.
    dx, dy = sun[0] - x, sun[1] - y
    dl = np.sqrt(dx * dx + dy * dy) + 1e-3
    dx, dy = dx / dl, dy / dl
    soft = blur(dens, 4 * S)
    path = sum(clamp_sample(soft, x + dx * k * 22 * S, y + dy * k * 22 * S) for k in range(1, 8))
    trans = np.exp(-path * 0.9)
    up = sum(clamp_sample(soft, x, y - k * 18 * S) for k in range(1, 4))
    forward = glow(x, y, sun[0], sun[1], [(260, 1.0)])
    sunlit = col(sun_col) * (trans * (0.55 + 1.6 * forward))[..., None]
    amb = lerp(L(col(shade)), L(col(lit)), np.exp(-up * 0.6)[..., None])
    cloud = amb * (0.55 + 0.45 * trans[..., None]) + sunlit * 0.6
    far = np.exp(-d / (0.10 * H))[..., None] * 0.85
    cloud = lerp(cloud, L(base), far)
    a = (1 - np.exp(-dens * 2.6))[..., None]
    rgb = rgb * (1 - a) + cloud * a
    return tonemap(rgb)


def sky_day():
    """Afternoon: deep blue overhead into a pale horizon, white cumulus with grey-blue undersides and
    silver edges round a high sun."""
    save("sky-day.jpg", sky(31, top=(0.22, 0.42, 0.78), mid=(0.42, 0.62, 0.90), horizon=(0.86, 0.90, 0.95),
                            sun=(W * 0.72, H * 0.16), sun_col=(1.6, 1.5, 1.35), sun_glow=(0.9, 0.85, 0.7),
                            lit=(0.95, 0.96, 0.99), shade=(0.50, 0.56, 0.68), coverage=0.15, disk=6))


def sky_dusk():
    """The same sky after sunset: the clouds caught pink and orange from below, deep blue overhead."""
    save("sky-dusk.jpg", sky(31, top=(0.05, 0.07, 0.20), mid=(0.20, 0.18, 0.40), horizon=(0.88, 0.50, 0.42),
                             sun=(W * 0.58, H * 0.98), sun_col=(2.2, 0.9, 0.5), sun_glow=(0.5, 0.18, 0.10),
                             lit=(0.42, 0.34, 0.56), shade=(0.10, 0.09, 0.20), coverage=0.15, stars=0.5))


# ---------------------------------------------------------------------------------------------------
# Nebula: emission gas and dark dust in a warped field, over stars of every temperature.


def nebula():
    rng = np.random.default_rng(41)
    x, y = grid()
    # Warped twice, so the gas folds into lobes and drawn-out strands rather than blobs.
    w1x, w1y, w2x, w2y = (noise(rng, H, W, beta=b) for b in (3.6, 3.6, 3.0, 3.0))
    qx, qy = x + w1x * 120 * S, y + w1y * 120 * S
    rx, ry = qx + sample(w2x, qx, qy) * 40 * S, qy + sample(w2y, qx, qy) * 40 * S
    gas = blur(sample(noise(rng, H, W, beta=3.7), rx, ry), 2 * S)
    strands = blur(np.clip(1 - np.abs(sample(noise(rng, H, W, beta=3.1), rx, ry)), 0, 1) ** 7, 1.5 * S)
    oiii = sample(noise(rng, H, W, beta=3.4), qx, qy)
    dust = sample(noise(rng, H, W, beta=3.5), rx, ry)
    lane = blur(np.clip(1 - np.abs(sample(noise(rng, H, W, beta=3.2), qx, qy)), 0, 1) ** 6, 2 * S)

    # A band from the upper left down to the right, brightest above the right third.
    u, v = x / W, y / W
    dist = np.abs((v - 0.05) - (u - 0.05) * 0.40) / np.sqrt(1 + 0.40**2)
    band = np.exp(-((dist + w1x * 0.035) / 0.12) ** 2)
    core = np.exp(-(((u - 0.70) / 0.17) ** 2 + ((v - 0.26) / 0.10) ** 2))

    dens = band * np.exp(gas * 1.2 - 1.0)
    emit = (dens[..., None] * col((0.24, 0.03, 0.05))
            + (strands * band * (0.3 + core))[..., None] * col((0.46, 0.08, 0.10))
            + (core**2 * np.exp(gas * 0.6))[..., None] * col((0.30, 0.19, 0.12))
            + ((core * 0.8 + band * 0.3) * smoothstep(-0.3, 1.8, oiii))[..., None] * col((0.04, 0.17, 0.30))
            + (band * 0.012)[..., None] * col((0.4, 0.3, 0.8)))
    absorb = np.exp(-(smoothstep(-0.2, 1.8, dust) * 2.2 + lane * 0.4 * smoothstep(-0.8, 0.8, dust)) * (0.25 + band))[..., None]
    bg = col((0.004, 0.004, 0.010))
    stars = starfield(rng, 24000, 0.85, weight=0.5 + 1.3 * band)
    rgb = bg + (emit + stars) * absorb
    rgb = bloom(rgb, ((4, 0.2), (30, 0.15)))
    save("nebula.jpg", tonemap(rgb, 1.0), blur_px=0.7)


# ---------------------------------------------------------------------------------------------------
# Aurora: curtains with ray striation over a dark ridge.


def aurora():
    rng = np.random.default_rng(53)
    x, y = grid()
    sky_c = ramp(y / H, [(0, (0.0005, 0.0008, 0.0025)), (0.7, (0.001, 0.003, 0.005)), (0.86, (0.002, 0.007, 0.009)), (1, (0.002, 0.006, 0.008))])
    rgb = sky_c + starfield(rng, 14000, 0.55, weight=smoothstep(H * 0.9, H * 0.2, y))
    curtains = np.zeros((H, W, 3), F)
    for k, (yb, amp, height, bright, freq, cx, wx) in enumerate([(0.36, 0.10, 0.36, 1.2, 1.2, 0.38, 0.42), (0.54, 0.05, 0.22, 0.8, 2.4, 0.80, 0.24),
                                                                (0.22, 0.04, 0.18, 0.35, 3.0, 0.88, 0.16)]):
        wob = noise1d(rng, W * 2, 3.2, low=1)[:W]
        base = H * (yb + amp * np.sin(x[0] / W * np.pi * freq + k * 1.7) + 0.022 * np.sin(x[0] / W * np.pi * 7.3 + k) + 0.03 * wob)
        h = (base[None, :] - y) / (H * height)
        # Rays: fine streaks across the curtain, slanted a little toward the top.
        rays = noise1d(rng, W * 4, 1.1, low=20)
        shear = x + (base[None, :] - y) * 0.12
        r = sample(rays[None, :].repeat(2, 0), (shear * 1.0) % (W * 4), np.zeros_like(x))
        streak = 0.35 + 0.65 * smoothstep(-0.6, 1.8, r)
        along = (smoothstep(-1.8, 1.2, noise1d(rng, W * 2, 4.5, low=1)[:W]) * np.exp(-((x[0] / W - cx) / wx) ** 2))[None, :]
        # Brightest at the lower edge, which is sharp; fading up the curtain.
        body = np.exp(-np.maximum(h, 0) * 2.4) * (1 + 1.4 * np.exp(-np.maximum(h, 0) * 14)) * np.exp(np.minimum(h, 0) * H * height / (5 * S))
        inten = body * streak * along * bright * smoothstep(1.4, 0.7, h)
        tint = ramp(np.clip(h, 0, 1.2), [(0, (0.30, 1.0, 0.50)), (0.25, (0.14, 0.95, 0.55)), (0.55, (0.12, 0.55, 0.55)),
                                         (0.85, (0.38, 0.22, 0.62)), (1.2, (0.55, 0.12, 0.42))])
        curtains += tint * inten[..., None]
    curtains *= 0.7
    rgb = rgb + curtains + blur(curtains, 30 * S) * 0.3
    ridge = ridge_line(rng, H * 0.88, H * 0.03, beta=2.4, sharp=0.5)
    airglow = col((0.004, 0.02, 0.016)) * np.exp(-np.abs(y - ridge[None, :]) / (60 * S))[..., None]
    rgb = rgb + airglow * smoothstep(0, 1, (ridge[None, :] - y + 1))[..., None]
    rgb, _ = layer(rgb, ridge, col((0.002, 0.004, 0.006)), y, soft=1.5)
    save("aurora.jpg", tonemap(rgb, 1.2))


# ---------------------------------------------------------------------------------------------------
# Ocean: a calm sea to the horizon, the sky mirrored in it, and a path of glitter under the light.


def ocean(seed, name, stops, light, light_col, halo, deep, size, stars=0.0, disk=1.0, column=0.1, sheen=0.25):
    rng = np.random.default_rng(seed)
    x, y = grid()
    hy = H * 0.52
    sky_c = L(ramp(y / H, stops))
    sky_c += col(halo) * glow(x, y, light[0], light[1], [(30, 1.2), (160, 0.45), (600, 0.22)])[..., None]
    sky_c += col(halo) * 0.35 * np.exp(-((y - hy) / (40 * S)) ** 2)[..., None]
    r = np.sqrt((x - light[0]) ** 2 + (y - light[1]) ** 2)
    sky_c += col(light_col) * smoothstep(size * 1.25, size * 0.75, r)[..., None] * disk
    if stars:
        sky_c += starfield(rng, 6000, stars, weight=smoothstep(hy, 0, y) ** 1.5)

    d = np.maximum(y - hy, 0.5)
    K = 26 * S
    X = (x - W * 0.5) * K / d
    Z = K * hy * 0.7 / d
    fp = np.maximum(K / d, K * hy * 0.7 / d**2)
    swell = noise(rng, 1024, 1024, beta=3.0, ax=3.0, ay=1.0)
    chop = noise(rng, 1024, 1024, beta=2.0, ax=2.0, ay=1.0)
    slope_t = (np.roll(swell, -1, 0) - swell) * 9 + (np.roll(chop, -1, 0) - chop) * 1.6
    sl = mip_sample(mips(slope_t), X * 2.5, Z * 2.5, fp * 2.5)
    glitter = noise(rng, 1024, 1024, beta=0.6, ax=2.5, ay=1.0)
    sp = mip_sample(mips(glitter), X * 8, Z * 8, fp * 8)

    # Fresnel: the sea is a mirror at the horizon and shows its own colour underfoot.
    theta = np.arctan(d / (W * 0.8))
    R = (0.02 + 0.98 * (1 - np.sin(theta)) ** 5)[..., None]
    tilt = np.clip(1.0 + sl * 0.3, 0.2, 3)
    mirror = clamp_sample(blur(blur_y(sky_c, 10 * S), 3 * S), x, hy - d * tilt)
    sea = col(deep) * (1 - R) + mirror * (sheen + (1 - sheen) * R)
    width = 24 * S + d * 0.42
    path = np.exp(-((x - light[0]) / width) ** 2) * smoothstep(0, 8, d)
    glint = smoothstep(2.9 - path, 3.4 - path, sp + sl * 0.15) * (0.5 + 2.5 * smoothstep(0, 400 * S, d))
    sea += col(light_col)[None, None] * (path * (glint * 4.0 + column))[..., None] * (1 - 0.5 * np.exp(-d / (40 * S)))[..., None]
    a = smoothstep(-0.7, 0.7, y - hy)[..., None]
    rgb = sky_c * (1 - a) + sea * a
    save(name, tonemap(bloom(rgb, ((3, 0.15), (30, 0.08)))))


def ocean_day():
    """Morning over a still sea: pale blue into a warm hazy horizon, the sun low and veiled."""
    ocean(61, "ocean-day.jpg", [(0, (0.42, 0.60, 0.80)), (0.36, (0.68, 0.79, 0.88)), (0.52, (0.96, 0.92, 0.85)), (1, (0.96, 0.92, 0.85))],
          light=(W * 0.62, H * 0.42), light_col=(1.5, 1.3, 1.0), halo=(0.6, 0.42, 0.22), deep=(0.02, 0.09, 0.15), size=26 * S,
          disk=0.8, column=0.12, sheen=0.15)


def ocean_night():
    """The same sea under a high moon: blue-black sky, a few stars, a long path of light on the water."""
    ocean(61, "ocean-night.jpg", [(0, (0.01, 0.02, 0.05)), (0.40, (0.03, 0.05, 0.10)), (0.52, (0.08, 0.10, 0.16)), (1, (0.08, 0.10, 0.16))],
          light=(W * 0.62, H * 0.20), light_col=(1.1, 1.15, 1.25), halo=(0.08, 0.10, 0.16), deep=(0.003, 0.008, 0.016), size=15 * S, stars=0.6,
          disk=2.5, column=0.04, sheen=0.3)



# ---------------------------------------------------------------------------------------------------
# Ridges: ranges of hills receding into the light, each one paler with distance and misted at its foot.


def ridges(stops, sun, sun_glow, near, haze, rim, stars=0.0):
    rng = np.random.default_rng(71)
    x, y = grid()
    rgb = L(ramp(y / H, stops)) + col(sun_glow) * glow(x, y, sun[0], sun[1], [(50, 1.0), (260, 0.5), (700, 0.12)])[..., None]
    if stars:
        rgb += starfield(np.random.default_rng(72), 6000, stars, weight=smoothstep(H * 0.5, 0, y) ** 1.5)
    n = 7
    for i in range(n):
        t = i / (n - 1)
        ridge = ridge_line(rng, H * (0.47 + 0.36 * t**1.15), H * (0.03 + 0.05 * t), beta=3.4, sharp=0.35)
        dy = y - ridge[None, :]
        # Mist gathers at a level, not along the ridge, so it is measured from the ridge smoothed out.
        level = np.convolve(np.pad(ridge, 200, mode="edge"), np.ones(401) / 401, "valid").astype(F)
        c = lerp(L(haze), L(near), t**1.5)
        mist = (1 - np.exp(-np.maximum(y - level[None, :] + H * 0.03, 0) / (H * (0.05 + 0.04 * t)))) * (0.75 - 0.45 * t)
        face = lerp(c, L(haze), mist[..., None])
        lit = np.exp(-np.maximum(dy, 0) / (2.5 * S)) * np.exp(-np.abs(x - sun[0]) / (W * 0.35)) * (1 - t) ** 1.5
        face = face + col(rim) * lit[..., None]
        rgb, _ = layer(rgb, ridge, face, y, soft=1.2)
    return tonemap(rgb)


def ridges_day():
    """Morning over ranges of hills: blue-violet ridges paling into a warm haze, the sun low on the left."""
    save("ridges-day.jpg", ridges([(0, (0.60, 0.70, 0.84)), (0.42, (0.90, 0.87, 0.86)), (0.6, (0.98, 0.88, 0.76)), (1, (0.98, 0.88, 0.76))],
                                  sun=(W * 0.30, H * 0.44), sun_glow=(0.55, 0.38, 0.16), near=(0.16, 0.20, 0.32), haze=(0.92, 0.87, 0.84),
                                  rim=(0.35, 0.25, 0.10)))


def ridges_night():
    """The same hills after sunset: indigo ridges, the last orange low in the sky and the first stars."""
    save("ridges-night.jpg", ridges([(0, (0.02, 0.03, 0.08)), (0.30, (0.07, 0.08, 0.17)), (0.47, (0.36, 0.22, 0.30)), (0.6, (0.55, 0.30, 0.25)), (1, (0.55, 0.30, 0.25))],
                                    sun=(W * 0.30, H * 0.52), sun_glow=(0.12, 0.04, 0.015), near=(0.012, 0.014, 0.03), haze=(0.36, 0.24, 0.30),
                                    rim=(0.10, 0.04, 0.02), stars=0.5))


# ---------------------------------------------------------------------------------------------------
# Forest: rows of pines going back into fog, light falling through it in shafts.


def forest(stops, fog, near, light, light_col, rays_amt):
    rng = np.random.default_rng(89)
    x, y = grid()
    rgb = L(ramp(y / H, stops)) + col(light_col) * glow(x, y, light[0], light[1], [(120, 0.5), (600, 0.4)])[..., None]
    n = 6
    for i in range(n):
        t = i / (n - 1)
        base = ridge_line(rng, H * (0.50 + 0.30 * t), H * (0.02 + 0.03 * t), beta=3.0)
        mask = np.zeros((H, W), F)
        tall = H * (0.08 + 0.32 * t**1.6)
        xt = -tall * 0.3
        while xt < W + tall * 0.3:
            ht = tall * rng.uniform(0.55, 1.15)
            hw = ht * rng.uniform(0.16, 0.22)
            bx = int(np.clip(xt, 0, W - 1))
            by = base[bx]
            y0, y1 = int(max(0, by - ht)), int(min(H, by + 4))
            x0, x1 = int(max(0, xt - hw - 2)), int(min(W, xt + hw + 2))
            if y0 < y1 and x0 < x1:
                yy, xx = np.mgrid[y0:y1, x0:x1].astype(F)
                f = np.clip((by - yy) / ht, 0, 1)
                rows = rng.uniform(0.35, 1.0, y1 - y0 + 6)
                rows = np.convolve(rows, np.ones(3) / 3, "same")[3:-3].astype(F)[:, None]
                width = hw * (1 - f) ** 0.95 * (0.45 + 0.55 * rows) + 0.6
                m = np.clip(width - np.abs(xx - xt) + 0.5, 0, 1) * (yy > by - ht)
                mask[y0:y1, x0:x1] = np.maximum(mask[y0:y1, x0:x1], m)
            xt += hw * rng.uniform(0.7, 1.4)
        ground = np.clip(y - base[None, :] + 0.5, 0, 1)
        mask = np.maximum(mask, ground)
        mask = blur(mask, (1 - t) * 2.5 * S + 0.3)
        c = lerp(L(fog), L(near), t**1.3)
        low = smoothstep(base[None, :] - tall * 0.6, base[None, :] + H * 0.05, y) * (0.55 - 0.35 * t)
        face = lerp(c, L(fog), low[..., None])
        if i == 2 and rays_amt:
            ang = np.arctan2(y - light[1], x - light[0])
            tex = noise1d(rng, 4096, 2.6, low=6)
            r = sample(tex[None, :].repeat(2, 0), (ang / np.pi + 1) * 2048 * 0.5, np.zeros_like(x))
            shafts = smoothstep(-0.5, 2.5, r) * 0.45 * np.exp(-np.hypot(x - light[0], y - light[1]) / (W * 0.7))
            rgb = rgb + col(light_col) * (shafts * rays_amt)[..., None]
        a = mask[..., None]
        rgb = rgb * (1 - a) + face * a
    return tonemap(rgb)


def forest_day():
    """A pine forest in morning fog: dark rows near, dissolving into pale grey-green, light slanting through."""
    save("forest-day.jpg", forest([(0, (0.78, 0.82, 0.82)), (0.6, (0.88, 0.89, 0.86)), (1, (0.88, 0.89, 0.86))],
                                  fog=(0.86, 0.88, 0.85), near=(0.12, 0.17, 0.16), light=(W * 0.78, -H * 0.15), light_col=(0.30, 0.26, 0.18), rays_amt=0.9))


def forest_night():
    """The same forest at night, the fog lit blue by a moon above the trees."""
    save("forest-night.jpg", forest([(0, (0.03, 0.05, 0.07)), (0.6, (0.09, 0.12, 0.15)), (1, (0.09, 0.12, 0.15))],
                                    fog=(0.12, 0.15, 0.18), near=(0.006, 0.01, 0.014), light=(W * 0.78, -H * 0.10), light_col=(0.05, 0.07, 0.10), rays_amt=0.7))


# ---------------------------------------------------------------------------------------------------
# Floodlights: banks of lamps throwing beams down through hazy night air.


def floodlights():
    rng = np.random.default_rng(107)
    x, y = grid()
    rgb = L(ramp(y / H, [(0, (0.01, 0.012, 0.02)), (1, (0.03, 0.035, 0.05))]))
    haze = sample(noise(rng, 1024, 1024, beta=3.0, ax=3.0), x * 0.5, y * 0.5)
    fog = 0.12 + 0.88 * smoothstep(-1.2, 2.0, haze)
    beams = np.zeros((H, W, 3), F)
    lamps = []
    # Three banks just above the frame, so only their beams and the glow round them show.
    banks = [((0.10, 0.015), (0.62, 1.1), (0.86, 0.92, 1.0), 6), ((0.90, 0.02), (0.36, 1.1), (0.90, 0.94, 1.0), 6),
             ((0.50, -0.05), (0.48, 1.2), (1.0, 0.90, 0.78), 3)]
    for (bx, by), (ax_, ay_), tint, n in banks:
        for j in range(n):
            lx, ly = W * bx + (j - n / 2) * 26 * S, H * by
            tx, ty = W * ax_ + rng.uniform(-0.2, 0.2) * W, H * ay_
            ln = np.hypot(tx - lx, ty - ly)
            dx, dy = (tx - lx) / ln, (ty - ly) / ln
            vx, vy = x - lx, y - ly
            along = vx * dx + vy * dy
            ang = np.abs(vx * dy - vy * dx) / np.maximum(along, 1)
            b = np.exp(-(ang / rng.uniform(0.018, 0.032)) ** 2) * (along > 0) / (1 + along / (1.2 * W))
            beams += np.array(tint, F) * b[..., None] * 0.16
            lamps.append((lx, ly, tint))
    rgb = rgb + beams * fog[..., None]
    # Dust and drizzle caught in the beams.
    m = 6000
    px, py = rng.uniform(0, W, m), rng.uniform(0, H, m)
    lum = beams.mean(-1)[py.astype(int), px.astype(int)]
    motes = splat(px, py, np.repeat((lum * rng.uniform(0.2, 1.0, m) * 1.5)[:, None], 3, 1))
    rgb = rgb + blur_y(blur(motes, 0.6), 2.5 * S) * 3
    pts = splat(np.array([p[0] for p in lamps]), np.array([p[1] for p in lamps]).clip(0, H - 1), np.array([p[2] for p in lamps], F) * 40)
    rgb = rgb + blur(pts, 24 * S) * 0.6 + blur(pts, 60 * S) * 0.8 + blur(pts, 200 * S) * 0.5
    pool = beams.mean(-1, keepdims=True) * smoothstep(H * 0.55, H * 1.0, y)[..., None]
    rgb = rgb + blur(pool, 80 * S) * col((0.9, 0.95, 1.0)) * 1.2
    save("floodlights.jpg", tonemap(rgb))


# ---------------------------------------------------------------------------------------------------
# Arcade: a striped sun setting behind ridges over a glowing grid.


def arcade():
    rng = np.random.default_rng(109)
    x, y = grid()
    hy = H * 0.60
    rgb = L(ramp(y / H, [(0, (0.03, 0.01, 0.09)), (0.30, (0.16, 0.04, 0.28)), (0.52, (0.62, 0.16, 0.42)), (0.60, (0.98, 0.48, 0.40)), (1, (0.98, 0.48, 0.40))]))
    rgb += starfield(rng, 5000, 0.6, weight=smoothstep(H * 0.4, 0, y) ** 2)
    cx, cy, R = W * 0.5, hy - H * 0.14, H * 0.21
    r = np.hypot(x - cx, y - cy)
    t = np.clip((y - (cy - R)) / (2 * R), 0, 1)
    sun_c = ramp(t, [(0, (1.0, 0.92, 0.50)), (0.5, (1.0, 0.55, 0.35)), (1, (0.95, 0.22, 0.55))])
    period = R * 0.13
    ph = ((y - cy) / period) % 1
    gap = np.clip((t - 0.48) * 1.1, 0, 0.6)
    bands = smoothstep(gap - 0.02, gap + 0.02, ph) * (t > 0.45) + (t <= 0.45)
    sun_a = smoothstep(R + 1, R - 1, r) * bands
    rgb = rgb + col((0.9, 0.3, 0.4)) * glow(x, y, cx, cy, [(120, 0.5), (500, 0.35)])[..., None]
    rgb = lerp(rgb, L(sun_c) * 1.4, sun_a[..., None])
    for base, amp, c, rim in [(0.585, 0.06, (0.10, 0.02, 0.16), (0.9, 0.2, 0.7)), (0.60, 0.035, (0.04, 0.0, 0.07), (0.4, 0.1, 0.9))]:
        ridge = ridge_line(rng, H * base, H * amp, beta=3.2, sharp=0.5)
        ridge = np.minimum(ridge, hy)
        dy = y - ridge[None, :]
        face = L(col(c)) + col(rim) * np.exp(-np.maximum(dy, 0) / (2.5 * S))[..., None] * 0.6
        rgb, _ = layer(rgb, ridge, face, y)
    d = np.maximum(y - hy, 0.5)
    K = 90 * S
    K2 = 0.25 * (H - hy) ** 2
    X = (x - W * 0.5) * K / d
    Z = K2 / d
    cell = 30.0
    lx = np.abs(((X / cell) + 0.5) % 1 - 0.5) * cell * d / K
    lz = np.abs(((Z / cell) + 0.5) % 1 - 0.5) * cell * d**2 / K2
    wpx = np.maximum(1.0 * S * d / (H - hy), 0.6)
    gl = np.exp(-(lx / wpx) ** 2) + np.exp(-(lz / wpx) ** 2)
    gl = np.clip(gl, 0, 1.2) * smoothstep(0, 140 * S, d)
    floor_c = L(ramp(np.clip((y - hy) / (H - hy), 0, 1), [(0, (0.30, 0.06, 0.30)), (0.3, (0.07, 0.01, 0.12)), (1, (0.02, 0.0, 0.05))]))
    refl = np.exp(-((x - cx) / (R * 0.9)) ** 2) * np.exp(-d / (H * 0.12))
    floor_c = floor_c + col((0.5, 0.15, 0.3)) * refl[..., None]
    line_c = ramp(np.clip(d / (H - hy), 0, 1), [(0, (1.2, 0.35, 0.9)), (1, (0.35, 0.6, 1.4))])
    floor_c = floor_c + line_c * gl[..., None]
    a = smoothstep(-0.7, 0.7, y - hy)[..., None]
    rgb = rgb * (1 - a) + floor_c * a
    rgb += col((0.7, 0.25, 0.5)) * np.exp(-((y - hy) / (14 * S)) ** 2)[..., None] * 0.25
    save("arcade.jpg", tonemap(bloom(rgb, ((3, 0.3), (24, 0.2), (90, 0.1)))), blur_px=1.0)


# ---------------------------------------------------------------------------------------------------
# Pixel: a lake among mountains drawn at 320x200 in a small palette, every pixel an 8x8 block.

BAYER4 = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]], F) / 16 + 1 / 32


def pixel(name, sky_pal, sun_pal, mtn, water_pal, trees, stars, moon):
    rng = np.random.default_rng(113)
    w, h = 320, 200
    yy, xx = np.mgrid[0:h, 0:w]
    bay = BAYER4[yy % 4, xx % 4]
    hy = 128
    pal = np.array(sky_pal, F) / 255
    tq = np.clip(yy / hy, 0, 1) * (len(pal) - 1)
    idx = np.clip(np.floor(tq + bay - 0.5 + 0.5), 0, len(pal) - 1).astype(int)
    img = pal[idx]
    if stars:
        s = (rng.random((h, w)) > 0.985) & (yy < 70)
        img[s] = np.array((232, 232, 255), F) / 255 * 0.9
    sx, sy, sr = 214, 74, 15 if not moon else 10
    r = np.hypot(xx - sx, yy - sy)
    sp = np.array(sun_pal, F) / 255
    sun = r < sr
    img[sun] = sp[0]
    if not moon:
        img[sun & (yy > sy + 4) & ((yy - sy) % 4 == 0)] = sp[1]
    else:
        img[sun & (np.hypot(xx - sx - 3, yy - sy + 2) < sr - 1) & (bay < 0.2)] = sp[1]
    ring = (r >= sr) & (r < sr + 6) & (bay < 0.35 * (1 - (r - sr) / 6))
    img[ring] = sp[2]
    # Clouds: streaks of noise above a threshold, a light top edge and a shaded underside.
    cn = np.asarray(Image.fromarray((fbm(rng, 640, 200, base=6, octaves=4) * 255).astype(np.uint8)).resize((w * 3, h)).crop((0, 0, w, h)), F) / 255
    cm = (cn > 0.66) & (yy < 60) & (yy > 14)
    top = cm & ~np.roll(cm, 1, 0)
    under = cm & ~np.roll(cm, -2, 0)
    cpal = np.array(sky_pal[-1], F) / 255
    img[cm] = lerp(img[cm], cpal, 0.55)
    img[top] = lerp(img[top], np.array(sun_pal[2], F) / 255, 0.7)
    img[under] = lerp(img[under], pal[1], 0.5)
    # Mountain ranges, far to near, each with a lit flank facing the sun.
    for i, (base, amp, c, lit) in enumerate(mtn):
        n = noise1d(rng, w * 4, 3.4, low=2)[:w]
        rr = 1 - np.abs(noise1d(rng, w * 4, 3.0, low=3)[:w])
        prof = np.round(base - amp * (0.5 * n + 0.8 * (rr - rr.mean()) / rr.std())).astype(int)
        m = yy >= prof[None, :]
        slope = np.gradient(prof.astype(F))
        litm = m & (slope[None, :] > 0) & (yy < prof[None, :] + 6 + 4 * i) & (bay < 0.7)
        img[m & (yy < hy)] = np.array(c, F) / 255
        img[litm & (yy < hy)] = np.array(lit, F) / 255
    # The lake: what stands above the shore, mirrored, with rows shifted by ripples and darkened.
    wp = np.array(water_pal, F) / 255
    for ry in range(hy, h):
        k = ry - hy
        src = hy - 1 - int(k * 1.2)
        if src < 0:
            src = 0
        shift = int(round(np.sin(ry * 0.9) * (1 + k * 0.05)))
        row = np.roll(img[src], shift, 0) * 0.78 + wp[0] * 0.22
        img[ry] = row
        if k % 3 == 1:
            img[ry, (bay[ry] < 0.25)] = wp[1]
    glint = (np.abs(xx - sx) < 3 + (yy - hy) * 0.5) & (yy > hy) & ((yy - hy) % 2 == 0) & (bay < 0.4)
    img[glint] = sp[2]
    img[hy] = wp[1]
    # Pines along both shores.
    tc = np.array(trees, F) / 255
    for side in (0, 1):
        for _ in range(26):
            tx = int(rng.uniform(0, 70)) if side == 0 else int(rng.uniform(250, 320))
            th = int(rng.uniform(16, 42) * (1.3 - abs(tx - (0 if side == 0 else 320)) / 120))
            base = hy + 4 + int(rng.uniform(0, 3))
            for k in range(max(th, 4)):
                half = int((k / th) * th * 0.28 * (0.6 + 0.4 * ((th - k) % 4) / 3)) if th else 0
                yk = base - th + k
                if 0 <= yk < h:
                    img[yk, max(0, tx - half):min(w, tx + half + 1)] = tc[0]
                    if half > 1 and side == 1:
                        img[yk, max(0, tx - half):max(0, tx - half + 1)] = tc[1]
            img[base:base + 3, max(0, tx - 0):tx + 1] = tc[0]
    big = np.repeat(np.repeat(img, 8, 0), 8, 1)
    save(name, big, quality=88, subsampling=0)


def pixel_day():
    """Pixel art at sunset: a striped sun over violet mountains and a still lake."""
    pixel("pixel-day.jpg",
          sky_pal=[(70, 90, 170), (100, 110, 190), (150, 120, 200), (210, 130, 180), (245, 160, 150), (255, 200, 150)],
          sun_pal=[(255, 236, 170), (250, 180, 130), (255, 214, 160)],
          mtn=[(104, 14, (150, 110, 170), (205, 150, 170)), (116, 16, (100, 80, 140), (170, 110, 150)), (126, 10, (60, 50, 100), (120, 80, 120))],
          water_pal=[(60, 70, 140), (240, 190, 170)], trees=[(30, 30, 60), (70, 50, 90)], stars=False, moon=False)


def pixel_night():
    """The same lake at night: a dithered moon, stars, the mountains in blue."""
    pixel("pixel-night.jpg",
          sky_pal=[(10, 12, 34), (18, 22, 52), (28, 34, 72), (40, 50, 96), (60, 70, 120), (84, 96, 140)],
          sun_pal=[(236, 236, 214), (190, 196, 200), (120, 130, 170)],
          mtn=[(104, 14, (52, 62, 104), (80, 96, 140)), (116, 16, (34, 42, 80), (60, 72, 118)), (126, 10, (20, 24, 52), (40, 48, 86))],
          water_pal=[(10, 14, 40), (110, 120, 170)], trees=[(6, 8, 20), (24, 30, 60)], stars=True, moon=True)


# ---------------------------------------------------------------------------------------------------
# Ink: mountains in wet-on-wet washes on paper, each ridge's ink pooled at its edge and bled into mist below.


def ink():
    rng = np.random.default_rng(127)
    x, y = grid()
    paper = col((0.95, 0.93, 0.88))
    mottle = blur(noise(rng, H, W, beta=2.6), 2 * S)
    fibre = blur(sample(noise(rng, 1024, 1024, beta=1.4, ax=0.25, ay=1.0), x * 0.7, y * 0.7), 1.2)
    D = np.zeros((H, W), F)
    for i in range(5):
        t = i / 4
        ridge = ridge_line(rng, H * (0.34 + 0.15 * t), H * (0.05 + 0.035 * t), beta=3.3, sharp=0.45)
        dy = y - ridge[None, :]
        level = np.convolve(np.pad(ridge, 120, mode="edge"), np.ones(241) / 241, "valid").astype(F)
        wash = np.exp(-np.maximum(y - level[None, :], 0) / (H * (0.05 + 0.05 * t))) * (dy > 0)
        wet = smoothstep(-0.8, 1.0, sample(noise(rng, 512, 512, beta=3.0), x * 0.25, y * 0.25))
        soft = blur(wash, 1.5 * S) * (1 - wet) + blur(wash, 9 * S) * wet
        rim = np.clip(soft - blur(soft, 5 * S), 0, 1) * 2.2
        gran = 0.85 + 0.15 * smoothstep(-1.5, 1.5, sample(noise(rng, 512, 512, beta=1.6), x, y))
        D += (soft + rim) * gran * (0.28 + 0.55 * t**1.3)
    sun = np.exp(-((np.hypot(x - W * 0.72, y - H * 0.20) / (H * 0.085)) ** 6))
    absorb = col((1.0, 1.04, 1.10))
    rgb = paper * (1 - 0.025 * mottle - 0.015 * fibre)[..., None] * np.exp(-D[..., None] * absorb * 1.6)
    rgb = lerp(rgb, rgb * col((1.0, 0.55, 0.42)), (sun * 0.55)[..., None])
    save("ink.jpg", rgb)


# ---------------------------------------------------------------------------------------------------
# Rain: drops on a window, each a small lens showing the lights behind it upside down.


def conv(img, kernel):
    """`img` convolved with `kernel` (centred, odd size) through the FFT, padded so it doesn't wrap."""
    kh, kw = kernel.shape
    ph, pw = img.shape[0] + kh, img.shape[1] + kw
    k = np.zeros((ph, pw), F)
    k[:kh, :kw] = kernel
    k = np.roll(k, (-(kh // 2), -(kw // 2)), (0, 1))
    kf = np.fft.rfft2(k)
    out = np.stack([np.fft.irfft2(np.fft.rfft2(img[..., c], s=(ph, pw)) * kf, s=(ph, pw))[: img.shape[0], : img.shape[1]] for c in range(3)], -1)
    return out.astype(F)


def disc_kernel(r):
    n = int(r) * 2 + 3
    yy, xx = np.mgrid[0:n, 0:n].astype(F) - n // 2
    d = np.hypot(xx, yy) / r
    k = smoothstep(1.0, 0.9, d) * (1 + 0.3 * smoothstep(0.6, 0.95, d))
    return k / k.sum()


def rain():
    rng = np.random.default_rng(131)
    _, y = grid()
    n = 260
    px = rng.uniform(-0.05, 1.05, n) * W
    py = H * np.clip(rng.normal(0.62, 0.18, n), 0.15, 1.1)
    palette = np.array([(1.0, 0.55, 0.20), (1.0, 0.86, 0.62), (1.0, 0.20, 0.10), (0.35, 0.80, 0.95), (0.55, 1.0, 0.65)], F)
    pc = palette[rng.choice(5, n, p=[0.42, 0.28, 0.16, 0.10, 0.04])] * rng.uniform(0.4, 2.0, n)[:, None] * 1100
    pts = splat(px, py, pc)
    base = L(ramp(y / H, [(0, (0.015, 0.02, 0.04)), (0.6, (0.04, 0.035, 0.06)), (1, (0.07, 0.04, 0.04))]))
    behind = base + conv(pts, disc_kernel(46 * S)) + blur(pts, 140 * S) * 4
    near = base + conv(pts, disc_kernel(7 * S)) * 0.9 + blur(pts, 60 * S) * 3
    fogged = blur(behind, 6 * S) + L(col((0.04, 0.04, 0.05)))
    rgb = fogged.copy()
    trails = np.zeros((H, W), F)
    drops = [(rng.uniform(0, W), rng.uniform(0, H), rng.uniform(1.6, 5.0) * S) for _ in range(500)]
    drops += [(rng.uniform(0, W), rng.uniform(0, H), np.exp(rng.uniform(np.log(8), np.log(30))) * S) for _ in range(150)]
    for cx, cy, r in drops:
        if r > 12 * S and rng.random() < 0.4:
            length = r * rng.uniform(4, 12)
            x0, x1 = int(max(0, cx - r)), int(min(W, cx + r))
            y0, y1 = int(max(0, cy - length)), int(max(0, cy))
            if x0 < x1 and y0 < y1:
                yy, xx = np.mgrid[y0:y1, x0:x1].astype(F)
                wob = np.sin(yy / (9 * S)) * r * 0.08
                tw = r * 0.35 * (0.4 + 0.6 * (yy - y0) / max(y1 - y0, 1))
                m = smoothstep(tw, tw * 0.6, np.abs(xx - cx - wob))
                trails[y0:y1, x0:x1] = np.maximum(trails[y0:y1, x0:x1], m)
    rgb = lerp(rgb, blur(behind, 2 * S), trails[..., None] * 0.8)
    for cx, cy, r in drops:
        ry = r * rng.uniform(1.0, 1.25)
        x0, x1 = int(max(0, cx - r - 2)), int(min(W, cx + r + 2))
        y0, y1 = int(max(0, cy - ry - 2)), int(min(H, cy + ry + 2))
        if x0 >= x1 or y0 >= y1:
            continue
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(F)
        dx, dy = (xx - cx) / r, (yy - cy) / ry
        ang = np.arctan2(dy, dx)
        dd = np.hypot(dx, dy) * (1 + 0.03 * np.sin(ang * 3 + cx) + 0.02 * np.sin(ang * 5 + cy))
        a = smoothstep(1.0, 0.86, dd)
        if a.max() <= 0:
            continue
        mag = 2.5 + r / S * 0.05
        refr = clamp_sample(near, cx - dx * r * mag, H * 0.58 + (cy - H * 0.58) * 0.35 - dy * ry * mag * 0.8)
        shade = 1 - 0.6 * smoothstep(0.55, 1.0, dd)
        spec = np.exp(-(((dx + 0.3) / 0.22) ** 2 + ((dy + 0.38) / 0.16) ** 2)) * 0.5
        caustic = np.exp(-(((dx - 0.1) / 0.4) ** 2 + ((dy - 0.65) / 0.18) ** 2)) * 0.25
        drop = refr * shade[..., None] + (spec + caustic)[..., None] * refr.mean((0, 1)) * 2 + spec[..., None] * 0.05
        region = rgb[y0:y1, x0:x1]
        rgb[y0:y1, x0:x1] = region * (1 - a[..., None]) + drop * a[..., None]
    save("rain.jpg", tonemap(rgb, 0.9))


DRAW = {
    "haze": [haze], "dunes": [dunes], "silk": [silk], "sky": [sky_day, sky_dusk], "nebula": [nebula],
    "aurora": [aurora], "ocean": [ocean_day, ocean_night], "ridges": [ridges_day, ridges_night],
    "forest": [forest_day, forest_night], "floodlights": [floodlights], "arcade": [arcade],
    "pixel": [pixel_day, pixel_night], "ink": [ink], "rain": [rain],
}

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name in sys.argv[1:] or DRAW:
        for draw in DRAW[name]:
            draw()
