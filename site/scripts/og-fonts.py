"""
The share cards' type, as static TTFs: next/og draws with Satori, which reads TTF, OTF and WOFF but
neither WOFF2 nor a variable font's axes.

    uv run --no-project --with fonttools --with brotli python scripts/og-fonts.py

Derived from the faces the desktop app bundles (apps/desktop/src/renderer/src/assets/fonts, SIL OFL
1.1), so the cards set type the way the site and the app do: Inter at the two weights the site's
headings and prose use, with its optical size at the default the site's Inter is served at (the site
loads only the weight axis), and JetBrains Mono for dates and versions. Subset to Latin, the
punctuation the cards set, and the symbols the changelog's entries use. Writes lib/og/fonts/, with
the two Inter cuts' advance widths beside them (metrics.json), which the cards measure their lines by.
"""

from pathlib import Path
import json
import shutil

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

SITE = Path(__file__).resolve().parent.parent
SOURCE = SITE.parent / "apps/desktop/src/renderer/src/assets/fonts"
OUT = SITE / "lib/og/fonts"

# Latin, Latin-1, Latin Extended-A, general punctuation, arrows, and the keys and marks entries name.
UNICODES = [
    *range(0x20, 0x7F),
    *range(0xA0, 0x180),
    *range(0x2010, 0x2028),
    *range(0x2030, 0x203B),
    *range(0x2190, 0x219A),
    0x2026, 0x20AC, 0x2122, 0x2212, 0x21E7, 0x22EF, 0x2318, 0x2325, 0x25B8,
]


def advances(font: TTFont) -> dict[str, int]:
    """Each character's advance, in font units."""
    hmtx = font["hmtx"]
    return {chr(code): hmtx[glyph][0] for code, glyph in sorted(font.getBestCmap().items())}


def write(font: TTFont, name: str) -> TTFont:
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=UNICODES)
    subsetter.subset(font)
    font.flavor = None
    font.save(OUT / name)
    print(f"wrote {OUT / name} ({(OUT / name).stat().st_size // 1024} KB)")
    return font


OUT.mkdir(parents=True, exist_ok=True)
metrics: dict[str, object] = {}
for weight in (400, 580):
    inter = write(instantiateVariableFont(TTFont(SOURCE / "InterVariable.woff2"), {"wght": weight, "opsz": 14}), f"Inter-{weight}.ttf")
    metrics["unitsPerEm"] = inter["head"].unitsPerEm
    metrics[str(weight)] = advances(inter)
(OUT / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, separators=(",", ":")) + "\n")
write(TTFont(SOURCE / "JetBrainsMono-Regular.woff2"), "JetBrainsMono-400.ttf")
shutil.copy(SOURCE / "OFL-Inter.txt", OUT / "OFL-Inter.txt")
shutil.copy(SOURCE / "OFL.txt", OUT / "OFL-JetBrainsMono.txt")
