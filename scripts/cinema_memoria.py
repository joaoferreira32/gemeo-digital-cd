"""Memory of the page with the cinema demo's two scenes, run again and again:
the GPU resources (renderer.info) and V8's heap after a full collection,
before the first run, at the end of each run (both scenes alive) and after it
(back in the app). Each run plays the feed cut to its end as fast as it draws.

    python scripts/cinema_memoria.py http://localhost:4173/ 5 [feed|galpao|galpao-completa]

Needs Playwright with its Chromium (pip install playwright; playwright install
chromium) and the app served (npm run build && npx vite preview). The heap is
read after the DevTools collection (HeapProfiler.collectGarbage), as in
scripts/demo_memoria.py; the workers' side is npm run bench:cinema-memoria.
"""
import sys
import time

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
RUNS = int(sys.argv[2]) if len(sys.argv) > 2 else 5
FORMAT = sys.argv[3] if len(sys.argv) > 3 else "feed"

with sync_playwright() as p:
    browser = p.chromium.launch(
        args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-precise-memory-info"]
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
        cdp.send("HeapProfiler.collectGarbage")
        cdp.send("HeapProfiler.collectGarbage")
        v8 = cdp.send("Runtime.getHeapUsage")["usedSize"] / 1e6
        gpu = page.evaluate(
            "() => { const r = __gemeo.renderer().info;"
            " return [r.memory.geometries, r.memory.textures, r.programs ? r.programs.length : -1]; }"
        )
        print(f"{label:<22} GPU: {gpu[0]} geometrias, {gpu[1]} texturas, {gpu[2]} programas | heap do V8 {v8:5.1f} MB")
        return v8, gpu

    measure("antes")
    for i in range(1, RUNS + 1):
        started = time.time()
        page.evaluate(f"() => __gemeo.cinema.start('{FORMAT}', 'fast')")
        page.wait_for_function(
            "() => { const p = __gemeo.cinema.player(); return p && p.frame >= p.frames - 1; }",
            timeout=600000,
            polling=250,
        )
        took = time.time() - started
        measure(f"fim da execução {i}")
        page.evaluate("() => __gemeo.cinema.stop()")
        time.sleep(3)
        measure(f"depois da execução {i}")
        print(f"   ({FORMAT}: o vídeo inteiro desenhado em {took:.1f} s, as duas simulações incluídas)")
    print("erros de console:", errors or "nenhum")
    browser.close()
