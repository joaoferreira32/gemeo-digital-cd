"""Plays the cinema demo live (as V does) and prints how well it kept real
time: the real seconds the whole play took from the first frame on screen,
the stalls (two frames more than 1.5 display refreshes apart) and the longest
gap between two frames. A frame is never skipped: a slow machine plays slower.

    python scripts/cinema_ao_vivo.py http://localhost:4173/ [feed|completa]

Needs Playwright with its Chromium (pip install playwright; playwright install
chromium) and the app served (npm run build && npx vite preview).
"""
import sys
import time

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
FORMATS = sys.argv[2:] or ["feed"]

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    page = browser.new_page(viewport={"width": 1600, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_selector("#loading.is-done", timeout=60000)
    time.sleep(3)
    for fmt in FORMATS:
        page.evaluate(f"() => __gemeo.cinema.start('{fmt}', 'live')")
        page.wait_for_function(
            "() => { const p = __gemeo.cinema.player(); return p && p.pace.seconds > 0; }",
            timeout=600000,
            polling=500,
        )
        r = page.evaluate("() => { const p = __gemeo.cinema.player(); return { ...p.pace, frames: p.frames }; }")
        print(
            f"{fmt}: {r['frames']} quadros em {r['seconds']:.2f} s reais (vídeo: {r['frames'] / 60:.2f} s); "
            f"{r['stalls']} engasgos (dois quadros a mais de 25 ms); maior intervalo {r['worstMs']:.1f} ms"
        )
        page.evaluate("() => __gemeo.cinema.stop()")
        time.sleep(2)
    print("erros de console:", errors or "nenhum")
    browser.close()
