"""Memory of the page after running the demo again and again: the GPU
resources (renderer.info) and V8's heap after a full collection, before the
first demo and after each one.

    python scripts/demo_memoria.py http://localhost:4173/ 6

Needs Playwright with its Chromium (pip install playwright; playwright install
chromium) and the app served (npm run build && npx vite preview).

The heap is read after the DevTools collection (HeapProfiler.collectGarbage,
run from outside any JavaScript). The page's own window.gc() (--expose-gc),
called from inside a script, left 6 to 8 MB of garbage after each demo, and
performance.memory read that as a "leak" of 22 MB; both are printed, side by
side, so the difference shows. The worker side is npm run bench:demo-memoria.
"""
import sys
import time

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
DEMOS = int(sys.argv[2]) if len(sys.argv) > 2 else 6

with sync_playwright() as p:
    browser = p.chromium.launch(
        args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist",
              "--js-flags=--expose-gc", "--enable-precise-memory-info"]
    )
    page = browser.new_page(viewport={"width": 1600, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text[:300]) if m.type == "error" else None)
    page.goto(URL)
    page.wait_for_selector("#loading.is-done", timeout=60000)
    time.sleep(8)
    cdp = page.context.new_cdp_session(page)

    def measure(label):
        for _ in range(3):
            page.evaluate("() => window.gc()")
            time.sleep(0.3)
        inside = page.evaluate("() => performance.memory.usedJSHeapSize") / 1e6
        cdp.send("HeapProfiler.collectGarbage")
        cdp.send("HeapProfiler.collectGarbage")
        v8 = cdp.send("Runtime.getHeapUsage")["usedSize"] / 1e6
        gpu = page.evaluate(
            "() => { const m = __gemeo.renderer().info.memory; const r = __gemeo.renderer().info;"
            " return [m.geometries, m.textures, r.programs ? r.programs.length : -1]; }"
        )
        print(f"{label:<18} GPU: {gpu[0]} geometrias, {gpu[1]} texturas, {gpu[2]} programas | "
              f"heap do V8 {v8:5.1f} MB | performance.memory depois de window.gc() {inside:5.1f} MB")

    measure("antes")
    for i in range(1, DEMOS + 1):
        page.keyboard.press("KeyV")
        page.wait_for_function(
            "() => __gemeo.director.phase === 'card' && __gemeo.director.cardSeconds >= 1",
            timeout=240000, polling=200,
        )
        page.keyboard.press("Escape")
        time.sleep(3)
        measure(f"depois da demo {i}")
    print("erros de console:", errors or "nenhum")
    browser.close()
