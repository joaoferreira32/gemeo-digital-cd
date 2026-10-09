"""The README GIF from the frames of scripts/demo_frames.py (Pillow only).

    ai/.venv/Scripts/python scripts/demo_gif.py pasta-dos-quadros docs/demo.gif

Frames are scaled to 640 px wide, share one adaptive palette (a GIF has 256
colors; one palette for the whole film avoids flicker between frames) and are
shown at 6 per second; the last one (the card) holds for 3.5 seconds.
"""
import os
import sys

from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else "quadros"
OUT = sys.argv[2] if len(sys.argv) > 2 else "docs/demo.gif"
WIDTH = 640
FRAME_MS = 167
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
palette = strip.quantize(colors=160, method=Image.Quantize.MEDIANCUT)
films = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in frames]
durations = [FRAME_MS] * len(films)
durations[-1] = HOLD_MS
films[0].save(OUT, save_all=True, append_images=films[1:], duration=durations, loop=0, optimize=True)
print(f"{OUT}: {len(films)} quadros, {os.path.getsize(OUT) / 1e6:.1f} MB")
