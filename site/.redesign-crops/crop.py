from PIL import Image
C = {
  "session": ("session-1440", 345, 140, 1428, 520),
  "session-phone": ("session-470", 61, 150, 462, 440),
  "lead": ("lead-1920", 350, 70, 1110, 615),
  "lead-phone": ("lead-900", 61, 70, 467, 720),
  "computer": ("lead-1920", 1134, 50, 1912, 585),
  "computer-phone": ("lead-900", 484, 50, 896, 985),
  "access": ("lead-1920", 60, 145, 324, 419),
}
for name, (src, x0, y0, x1, y1) in C.items():
    im = Image.open(f"out/{src}.png").convert("RGB")
    im.crop((x0*2, y0*2, x1*2, y1*2)).save(f"crops/{name}.png")
    print(name, (x1-x0, y1-y0))
