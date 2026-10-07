"""The JPEG frames screen-motion.test.ts reads, made the way serve-sim makes its own.

serve-sim streams baseline JPEGs, 4:2:0, with a restart marker at the end of every row of 16-px
MCUs (MEASURED on iOS 27: 1320x2868, restart interval 83). These are the same shape at 320x96 —
20 columns, 6 bands — so a test can say where a change is without a simulator.

    python3 apps/server/src/simulators/fixtures/frames.py
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 320, 96


def base() -> Image.Image:
    im = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(im)
    for band in range(6):
        y = band * 16
        d.rectangle([8, y + 4, 8 + 60 + band * 9, y + 11], fill=(40, 40, 40))  # a label
        d.rectangle([230, y + 5, 236, y + 10], fill=(150, 150, 150))  # a chevron
    return im


def save(im: Image.Image, name: str, restart: bool = True) -> None:
    opts = {"quality": 90, "subsampling": 2}
    if restart:
        opts["restart_marker_rows"] = 1
    im.save(os.path.join(HERE, name), "JPEG", **opts)


save(base(), "frame-base.jpg")

# The scroll indicator: a thin bar in the last column, down four bands — the picture of a list whose
# indicator is fading after a push, which is not the screen moving.
im = base()
ImageDraw.Draw(im).rectangle([308, 18, 311, 76], fill=(120, 120, 120))
save(im, "frame-indicator.jpg")

# The same bar at the first of the edge columns. Where a byte holds the end of one column's code and
# the start of the next's, the first byte that differs belongs half to the column before — so a change
# is placed by its first differing BIT, or this reads as a change inside the screen.
im = base()
ImageDraw.Draw(im).rectangle([288, 18, 291, 76], fill=(120, 120, 120))
save(im, "frame-indicator-inner.jpg")

# A switch flipping near the right edge, but not AT it: a change that means something.
im = base()
ImageDraw.Draw(im).rectangle([250, 34, 282, 44], fill=(52, 199, 89))
save(im, "frame-switch.jpg")

# The whole screen shifted sideways: a push, a scroll.
im = Image.new("RGB", (W, H), (255, 255, 255))
im.paste(base(), (-24, 0))
save(im, "frame-shifted.jpg")

# The same picture without restart markers: a frame this cannot read by band.
save(base(), "frame-no-restarts.jpg", restart=False)
