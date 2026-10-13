"""Records the cinema demo as the page does with ⇧V (frame by frame: WebCodecs
H.264 and Mediabunny's MP4), saves the file and prints what it holds, read
from its boxes (src/demo/mp4.ts): frames, seconds, frames per second and the
longest gap between two frames; and how long the recording took.

    python scripts/cinema_gravar.py http://localhost:4173/ pasta-dos-videos [feed|completa]

Needs Playwright with its Chromium (pip install playwright; playwright install
chromium) and the app served (npm run build && npx vite preview).
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "videos-cinema"
FORMATS = sys.argv[3:] or ["feed", "completa"]

os.makedirs(OUT, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    page = browser.new_page(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text[:300]) if m.type == "error" else None)
    page.goto(URL)
    page.wait_for_selector("#loading.is-done", timeout=60000)
    time.sleep(1)
    for fmt in FORMATS:
        page.evaluate("() => { window.__before = __gemeo.lastVideo(); }")
        started = time.time()
        with page.expect_download(timeout=900000) as download:
            page.evaluate(f"() => __gemeo.cinema.start('{fmt}', 'record')")
        took = time.time() - started
        path = os.path.join(OUT, download.value.suggested_filename)
        download.value.save_as(path)
        page.wait_for_function("() => __gemeo.lastVideo() !== window.__before", timeout=60000)
        video = page.evaluate("() => __gemeo.lastVideo()")
        f = video["file"]
        print(
            f"{fmt}: {path} — {video['bytes'] / 1e6:.1f} MB, {f['frames']} quadros em {f['seconds']:.3f} s "
            f"({f['fps']:.3f} FPS; maior intervalo {f['longestGap'] * 1000:.2f} ms); "
            f"{video['drawn']} quadros desenhados; gravação levou {took:.1f} s"
        )
        time.sleep(2)
    print("erros de console:", errors or "nenhum")
    browser.close()
