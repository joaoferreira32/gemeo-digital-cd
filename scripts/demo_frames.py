"""Frames of the demo for the README GIF: plays the demo (key V) in Chromium and
saves screenshots of the beats that tell the story.

    python scripts/demo_frames.py http://localhost:4173/ pasta-dos-quadros

Needs Playwright with its Chromium (pip install playwright; playwright install
chromium) and the app served (npm run build && npx vite preview). Then
scripts/demo_gif.py turns the frames into docs/demo.gif.
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "quadros"
FPS = 6
# Beat of the demo (src/demo/beats.ts), real seconds into it before the first
# frame, and frames to keep (the card is one frame, held at the end of the GIF).
TAKE = [
    ("aberto", 0.6, 6),
    ("falha", 0.8, 10),
    ("fila", 1.0, 9),
    ("gargalo", 1.2, 9),
    ("desvio", 0.6, 7),
    ("manutencao", 3.0, 8),
    ("volta", 0.6, 5),
    ("sem-ia", 2.0, 10),
    ("resultado", 1.2, 1),
]

os.makedirs(OUT, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    page = browser.new_page(viewport={"width": 1280, "height": 720})
    page.goto(URL)
    page.wait_for_selector("#loading.is-done", timeout=60000)
    time.sleep(1)
    page.keyboard.press("KeyV")
    # The page's own controls (the exit button) stay out of the GIF; the captions are the canvas.
    page.wait_for_selector("#demo-bar:not([hidden])")
    page.evaluate("() => { document.getElementById('demo-bar').style.visibility = 'hidden'; }")
    current = lambda: page.evaluate("() => __gemeo.director.current?.id ?? null")
    n = 0
    report = []
    start = time.time()
    for beat, delay, count in TAKE:
        while current() != beat and time.time() - start < 180:
            time.sleep(0.03)
        time.sleep(delay)
        for _ in range(count):
            t = time.time()
            page.screenshot(path=os.path.join(OUT, f"{n:04d}.png"))
            n += 1
            time.sleep(max(0, 1 / FPS - (time.time() - t)))
        report.append(f"{beat} {count}")
    browser.close()
print(f"{n} quadros em {OUT}: " + ", ".join(report))
