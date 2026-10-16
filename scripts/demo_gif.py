"""The README GIF from a folder of frames (Pillow only).

    ai/.venv/Scripts/python scripts/demo_gif.py pasta-dos-quadros docs/demo.gif [largura] [ms]

Frames are scaled to `largura` px wide (640 by default), share one adaptive
palette (a GIF has 256 colors; one palette for the whole film avoids flicker
between frames) and are shown `ms` milliseconds each (167, 6 per second); the
last one (the card, or the address) holds for 3.5 seconds.
"""
import os
import sys

from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else "quadros"
OUT = sys.argv[2] if len(sys.argv) > 2 else "docs/demo.gif"
WIDTH = int(sys.argv[3]) if len(sys.argv) > 3 else 640
FRAME_MS = int(sys.argv[4]) if len(sys.argv) > 4 else 167
HOLD_MS = 3500

names = sorted(f for f in os.listdir(SRC) if f.endswith(".png"))
if not names:
    sys.exit(f"nenhum quadro em {SRC}")
frames = []
for name in names:
    im = Image.open(os.path.join(SRC, name)).convert("RGB")
    h = round(im.height * WIDTH / im.width)
    frames.append(im.resize((WIDTH, h), Image.LANCZOS))
# One palette for the film, from a strip of frames taken across it.
step = max(1, len(frames) // 12)
strip = Image.new("RGB", (WIDTH, frames[0].height * len(frames[::step])))
for i, im in enumerate(frames[::step]):
    strip.paste(im, (0, i * frames[0].height))
# The colors that carry a meaning (the queue's red, "sem IA" orange, the AI's cyan, the
# worn motor's yellow, the words' white) go into the strip in solid blocks, so the
# palette keeps them apart instead of merging the red into the orange.
KEY = ["#ff5d5d", "#ff8f3a", "#38e1d6", "#ffd166", "#f2f6fa", "#9aa4ae"]
block = 24
keys = Image.new("RGB", (WIDTH, block * 8))
for i, color in enumerate(KEY):
    keys.paste(Image.new("RGB", (WIDTH // len(KEY), block * 8), color), (i * (WIDTH // len(KEY)), 0))
full = Image.new("RGB", (WIDTH, strip.height + keys.height))
full.paste(strip, (0, 0))
full.paste(keys, (0, strip.height))
palette = full.quantize(colors=176, method=Image.Quantize.MEDIANCUT)
films = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in frames]
durations = [FRAME_MS] * len(films)
durations[-1] = HOLD_MS
films[0].save(OUT, save_all=True, append_images=films[1:], duration=durations, loop=0, optimize=True)
print(f"{OUT}: {len(films)} quadros, {os.path.getsize(OUT) / 1e6:.1f} MB")
