"""Key frames of the cinema demo, drawn by the app itself: the exact frames of
the video (the canvas the recording encodes, saved pixel for pixel), at the
video seconds below.

    python scripts/cinema_frames.py http://localhost:4173/ pasta-dos-quadros [feed|completa|galpao|galpao-completa]

Needs Playwright with its Chromium (pip install playwright; playwright install
chromium) and the app served (npm run build && npx vite preview).
"""
import base64
import os
import sys
import time

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "quadros-cinema"
FORMATS = sys.argv[3:] or ["feed", "completa", "galpao", "galpao-completa"]
# Name and video second of each frame (src/demo/cinema.ts gives the segments).
FRAMES = {
    "feed": [
        ("1-gancho", 3.4),
        ("2-tela-dividida", 18.3),
        ("3a-raio-x-calor", 21.0),
        ("3b-raio-x-rotas", 23.5),
        ("3c-raio-x-desvio", 25.5),
        ("3d-raio-x-gargalo", 28.0),
        ("4a-previsao", 38.3),
        ("4b-previsao-climax", 47.4),
        ("5-resultado", 59.5),
    ],
    "completa": [
        ("1-gancho", 3.4),
        ("2-frase", 6.0),
        ("3-volta-no-tempo", 8.5),
        ("4-como-esteiras", 17.0),
        ("5-como-robos", 26.0),
        ("6-quebra", 33.0),
        ("7-tela-dividida", 48.0),
        ("8-raio-x-gargalo", 60.0),
        ("9-previsao-climax", 79.15),
        ("10-resultado", 93.0),
        ("11-endereco", 98.0),
    ],
    # The tour and the AI at work (?demo=cinema-galpao and its 16:9 version).
    "galpao": [
        ("01-teaser", 3.0),
        ("02-rebobinada", 6.6),
        ("03-passeio-aereo", 8.4),
        ("04-passeio-entrada", 12.5),
        ("05-passeio-portao", 21.3),
        ("06-passeio-doca", 26.2),
        ("07-quebra-detector", 33.0),
        ("08-ia-assume", 46.8),
        ("09-raio-x", 70.0),
        ("10-motores", 76.8),
        ("11-manutencao", 86.0),
        ("12-falha-evitada", 89.6),
        ("13-numeros", 95.0),
        ("14-fim", 104.5),
    ],
    "galpao-completa": [
        ("01-teaser", 3.0),
        ("04-passeio", 22.0),
        ("08-ia-assume", 57.0),
        ("11-manutencao", 96.2),
        ("13-numeros", 110.0),
    ],
}

os.makedirs(OUT, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text[:300]) if m.type == "error" else None)
    page.goto(URL)
    page.wait_for_selector("#loading.is-done", timeout=60000)
    time.sleep(1)
    for fmt in FORMATS:
        frames = [(name, round(second * 60)) for name, second in FRAMES[fmt]]
        started = time.time()
        page.evaluate(f"() => __gemeo.cinema.start('{fmt}', 'fast')")
        page.wait_for_function("() => __gemeo.cinema.player() !== null", timeout=60000)
        shots = page.evaluate(
            "async (ks) => Promise.all(ks.map((k) => __gemeo.cinema.shot(k)))",
            [k for _, k in frames],
        )
        for (name, k), url in zip(frames, shots):
            path = os.path.join(OUT, f"{fmt}-{name}.png")
            with open(path, "wb") as f:
                f.write(base64.b64decode(url.split(",", 1)[1]))
            print(f"{path}: quadro {k} ({k / 60:.2f} s do vídeo)")
        page.evaluate("() => __gemeo.cinema.stop()")
        print(f"{fmt}: {time.time() - started:.1f} s")
        time.sleep(1)
    print("erros de console:", errors or "nenhum")
    browser.close()
