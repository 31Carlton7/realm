"""Lays each generated icon onto the macOS icon grid.

    python3 compose-alternates.py <dir-of-generated-pngs> <dir-for-1024-masters>

The artwork in `alternates/` was generated (GPT Image, through Codex) as whole icons: a body, a mark,
and a shadow keyed out of a backdrop. The model's idea of an icon is close to Apple's and never on it
— the body lands at 85-92% of the canvas, its corner is its own, and the keyed shadow keeps a fringe
of whatever the backdrop was. So only the BODY is taken from the picture. It is found by its opaque
core, scaled onto the grid's 824 px body at (100, 100), cut to the continuous-corner shape every Mac
icon shares, and given the grid's own shadow — which is what makes nine pictures from nine prompts
sit in a row as one set, and beside the other icons in a Dock.

`default.png` is also shipped as the app's own icon (resources/icon.png and icon.icns), which replaces
the vector render of app-icon.svg (render.mjs) as the bundle icon. app-icon.svg stays the source of the
mark's geometry, which every generation was given as its reference.

Writes, for every <name>.png in the input:
  <masters>/<name>.png               1024 px, the master — the default's becomes resources/icon.png and
                                     the .icns (render.mjs's iconutil step); the rest are not committed
  ../../apps/desktop/src/renderer/src/assets/app-icons/<name>.png   256 px, what Settings shows and
                                     what the Dock is handed at run time (it never draws one larger
                                     than 256 px on a 2x display)
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
RESOURCES = HERE.parent
RUNTIME = HERE.parents[1] / "apps/desktop/src/renderer/src/assets/app-icons"

CANVAS, BODY, ORIGIN = 1024, 824, 100
SS = 4  # supersampling for the mask's edge
# Apple's continuous corner, close enough at icon scale: a superellipse |x|^n + |y|^n = 1. n = 5 is
# the exponent the Big Sur template is usually measured at; a circle-cornered rounded rect at the
# same size reads visibly "web".
N = 5.0


def squircle_mask(size: int) -> Image.Image:
    big = size * SS
    r = big / 2
    pts = []
    steps = 720
    import math
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        x = r + r * math.copysign(abs(c) ** (2 / N), c)
        y = r + r * math.copysign(abs(s) ** (2 / N), s)
        pts.append((x, y))
    m = Image.new("L", (big, big), 0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def body_box(im: Image.Image) -> tuple[int, int, int, int]:
    """The opaque core's bounds. The keyed shadow is soft and partial, the body is not, so a high
    alpha threshold finds the body alone. A row or column counts only when a fifth of it is body,
    which ignores the specks a keyed backdrop leaves behind."""
    a = im.getchannel("A").point(lambda v: 255 if v > 200 else 0)
    w, h = a.size
    px = a.load()
    cols = [sum(1 for y in range(0, h, 2) if px[x, y]) for x in range(w)]
    rows = [sum(1 for x in range(0, w, 2) if px[x, y]) for y in range(h)]
    need_c, need_r = h / 2 / 5, w / 2 / 5
    xs = [x for x, n in enumerate(cols) if n > need_c]
    ys = [y for y, n in enumerate(rows) if n > need_r]
    return xs[0], ys[0], xs[-1] + 1, ys[-1] + 1


def compose(src: Path) -> Image.Image:
    im = Image.open(src).convert("RGBA")
    # Inset a hair so the cut lands inside the model's own rim rather than on its fringe.
    x0, y0, x1, y1 = body_box(im)
    inset = round((x1 - x0) * 0.006)
    body = im.crop((x0 + inset, y0 + inset, x1 - inset, y1 - inset)).resize((BODY, BODY), Image.LANCZOS)
    mask = squircle_mask(BODY)
    # The body's own alpha survives inside the cut (frosted glass is partly translucent by design).
    body.putalpha(ImageChops.multiply(body.getchannel("A"), mask))

    out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    # The grid's shadow: a tight contact shade and a wide soft one, both straight down.
    for blur, dy, alpha in ((6, 4, 70), (24, 12, 80)):
        sh = Image.new("L", (CANVAS, CANVAS), 0)
        sh.paste(mask.point(lambda v: v * alpha // 255), (ORIGIN, ORIGIN + dy))
        sh = sh.filter(ImageFilter.GaussianBlur(blur))
        layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        layer.putalpha(sh)
        out.alpha_composite(layer)
    out.alpha_composite(body, (ORIGIN, ORIGIN))
    return out


def ship_default(master: Path) -> None:
    """The default is the icon the bundle carries: resources/icon.png and the .icns every size of
    Finder and Dock draws from (stage-pack copies it to build/ for electron-builder)."""
    shutil.copyfile(master, RESOURCES / "icon.png")
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        im = Image.open(master)
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                name = f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
                im.resize((size * scale, size * scale), Image.LANCZOS).save(iconset / name)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(RESOURCES / "icon.icns")], check=True)


def main() -> None:
    src_dir, MASTERS = Path(sys.argv[1]), Path(sys.argv[2])
    MASTERS.mkdir(parents=True, exist_ok=True)
    RUNTIME.mkdir(parents=True, exist_ok=True)
    for src in sorted(src_dir.glob("*.png")):
        icon = compose(src)
        icon.save(MASTERS / src.name, optimize=True)
        icon.resize((256, 256), Image.LANCZOS).save(RUNTIME / src.name, optimize=True)
        print("composed", src.name)
        if src.stem == "default":
            ship_default(MASTERS / src.name)
            print("shipped default -> icon.png, icon.icns")


if __name__ == "__main__":
    main()
