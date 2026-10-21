"""Render the MARVIN film to video.

  python3 render.py stills OUT_DIR t1 t2 ...       # PNG stills at given seconds
  python3 render.py segment START END OUT.mp4      # frames [START, END) -> H.264 segment
  python3 render.py full [WORKERS]                 # whole film -> out/MARVIN_SIH2026_3D_1080p.mp4
"""
import os, subprocess, sys, time
from pathlib import Path
import imageio_ffmpeg
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PORT = int(os.environ.get('FILM_PORT', '8765'))
# FILM_CUT=impact renders the 50 s feasibility/viability/impact cut from impact.html.
CUT = os.environ.get('FILM_CUT', 'main')
FPS, DURATION = 30, (50 if CUT == 'impact' else 135)
DPR = int(os.environ.get('FILM_DPR', '1'))  # 2 = 3840×2160 (4K)
PAGE = 'impact.html' if CUT == 'impact' else 'index.html'
URL = f'http://127.0.0.1:{PORT}/video/{PAGE}?dpr={DPR}'
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
# Hardware GPU (Intel iGPU via ANGLE/OpenGL) is ~7x faster than SwiftShader; FILM_SOFTWARE=1 falls back.
GPU_ARGS = ['--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
SOFT_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
SOFTWARE = os.environ.get('FILM_SOFTWARE') == '1'


def open_film(p):
    browser = p.chromium.launch(args=SOFT_ARGS) if SOFTWARE else p.chromium.launch(args=GPU_ARGS, channel='chromium')
    page = browser.new_page(viewport={'width': 1920, 'height': 1080}, device_scale_factor=DPR)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.goto(URL)
    try:
        page.wait_for_function('window.filmReady === true', timeout=120000)
    except Exception:
        print('\n'.join(errors), file=sys.stderr)
        raise
    return browser, page, errors


def shoot(page, t, fmt='jpeg'):
    page.evaluate(f'window.renderFrame({t})')
    if fmt == 'png':
        return page.screenshot(type='png', clip={'x': 0, 'y': 0, 'width': 1920, 'height': 1080})
    return page.screenshot(type='jpeg', quality=97, clip={'x': 0, 'y': 0, 'width': 1920, 'height': 1080})


def stills(out_dir, times):
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser, page, errors = open_film(p)
        for t in times:
            start = time.time()
            (out / f't{float(t):07.2f}.png').write_bytes(shoot(page, float(t), 'png'))
            print(f't={t} {time.time() - start:.2f}s', flush=True)
        if errors: print('ERRORS:', errors[:5])
        browser.close()


def encoder(path):
    return subprocess.Popen([FFMPEG, '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', str(FPS), '-c:v', 'mjpeg', '-i', '-',
                             '-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-threads', '2',
                             '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
                             '-r', str(FPS), str(path)], stdin=subprocess.PIPE)


def segment(a, b, path):
    with sync_playwright() as p:
        browser, page, errors = open_film(p)
        enc = encoder(path)
        t0 = time.time()
        for f in range(a, b):
            enc.stdin.write(shoot(page, f / FPS))
            if (f - a) % 60 == 0:
                done = f - a + 1
                print(f'[{a}-{b}] frame {f} ({done}/{b - a}) {(time.time() - t0) / done:.2f}s/frame', flush=True)
        enc.stdin.close(); enc.wait()
        if errors: print('ERRORS:', errors[:5], flush=True)
        browser.close()
    if enc.returncode: sys.exit(enc.returncode)


def full(workers):
    out = HERE / 'out'; out.mkdir(exist_ok=True)
    server = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1', '--directory', str(ROOT)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    try:
        total = FPS * DURATION
        bounds = [round(total * i / workers) for i in range(workers + 1)]
        segs = [out / f'seg_{CUT}{i:02d}.mp4' for i in range(workers)]
        # Low CPU priority keeps the laptop responsive while rendering.
        procs = [subprocess.Popen(['nice', '-n', '15', sys.executable, __file__, 'segment', str(bounds[i]), str(bounds[i + 1]), str(segs[i])]) for i in range(workers)]
        codes = [p.wait() for p in procs]
        if any(codes): sys.exit(f'segment failed: {codes}')
        listing = out / f'segments_{CUT}.txt'
        listing.write_text(''.join(f"file '{s}'\n" for s in segs))
        name = 'MARVIN_SIH2026_Impact' if CUT == 'impact' else 'MARVIN_SIH2026_3D'
        final = out / (f'{name}_4K.mp4' if DPR == 2 else f'{name}_1080p.mp4')
        subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(listing), '-c', 'copy', '-an',
                        '-movflags', '+faststart', str(final)], check=True)
        for s in segs: s.unlink()
        listing.unlink()
        print('DONE', final)
    finally:
        server.terminate()


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'stills': stills(sys.argv[2], sys.argv[3:])
    elif mode == 'segment': segment(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4])
    elif mode == 'full': full(int(sys.argv[2]) if len(sys.argv) > 2 else 1)
