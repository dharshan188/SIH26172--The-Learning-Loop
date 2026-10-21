"""Build the MARVIN demo edit from the clips in this folder, in this order:

  first.webm                          full screen (home + live monitor)
  secondmain.webm + second.mp4        side-by-side split, title "With noise", audio from second.mp4
  last.webm                           full screen (model comparison, dataset)
  thirdmain.webm  + third.mp4         side-by-side split, title "Hard negatives", audio from third.mp4

Only the split sections carry sound (the hardware voice from the phone clip). The phone clip is rotated to
landscape and sits beside the screen recording at the same height. second.mp4 starts at 45 s while
first.webm keeps playing on the left until 47 s, then secondmain.webm takes over the left as usual.
From the moment MARVIN is detected in "Hard negatives", the Latest Transcript box reads "Listening…".

Each split opens from the full-screen recording; when the phone clip ends, it closes back to full screen.

  python3 edit_split.py            -> out/MARVIN_demo_edit_1080p.mp4
"""
import itertools, subprocess, sys
from pathlib import Path
import numpy as np
import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
OUT = HERE / 'out'
FONT = HERE.parent / 'video' / 'fonts' / 'SpaceGrotesk.ttf'
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
# Encode on the Intel iGPU (VA-API) with Ubuntu's ffmpeg when available; otherwise fall back to CPU x264.
GPU_DEV = '/dev/dri/renderD128'
GPU = Path('/usr/bin/ffmpeg').exists() and Path(GPU_DEV).exists() and '--cpu' not in sys.argv
ENC_FFMPEG = '/usr/bin/ffmpeg' if GPU else FFMPEG
HW_IN = ['-vaapi_device', GPU_DEV] if GPU else []
VCODEC = ['-c:v', 'h264_vaapi', '-qp', '18'] if GPU else ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p']
UPLOAD = ',format=nv12,hwupload' if GPU else ''
W, H, FPS = 1920, 1080, 30
BG_TOP, BG_BOT = (16, 34, 72), (7, 14, 32)
CLOSE = .5  # seconds for the split to close after the phone clip ends


def probe_duration(path):
    out = subprocess.run([FFMPEG, '-hide_banner', '-i', str(path)], capture_output=True, text=True).stderr
    h, m, s = out.split('Duration: ')[1].split(',')[0].split(':')
    return int(h) * 3600 + int(m) * 60 + float(s)


def frames(path, w, h, ss=None, t=None, rotate=False):
    """Decode a clip (optionally from ss for t seconds) as RGB frames at FPS, scaled to w×h.
    rotate turns a portrait phone clip 90° counter-clockwise into landscape."""
    cut = (['-ss', str(ss)] if ss is not None else []) + (['-t', str(t)] if t is not None else [])
    rot = 'transpose=2,' if rotate else ''
    p = subprocess.Popen([FFMPEG, '-loglevel', 'error', *cut, '-i', str(path), '-vf', f'{rot}fps={FPS},scale={w}:{h}:flags=lanczos,format=rgb24',
                          '-f', 'rawvideo', '-'], stdout=subprocess.PIPE)
    size = w * h * 3
    while (buf := p.stdout.read(size)) and len(buf) == size:
        yield Image.frombuffer('RGB', (w, h), buf)
    p.wait()


def encoder(path, audio=None, audio_delay=0.0):
    cmd = [ENC_FFMPEG, '-y', '-loglevel', 'error', *HW_IN, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-']
    if audio:
        cmd += ['-i', str(audio), '-map', '0:v', '-map', '1:a', '-af', 'apad', '-shortest']
    else:
        cmd += ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a', '-shortest']
    if GPU: cmd += ['-vf', UPLOAD.lstrip(',')]
    cmd += [*VCODEC, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', str(path)]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)


def background():
    k = np.linspace(0, 1, H)[:, None, None]
    grad = (np.array(BG_TOP) * (1 - k) + np.array(BG_BOT) * k).astype(np.uint8)
    return Image.fromarray(np.repeat(grad, W, axis=1))


BG = background()
FIRST_CUT = 47.0   # first.webm plays until here, then secondmain.webm
PHONE_LEAD = 2.0   # second.mp4 starts this much earlier (45 s), beside the tail of first.webm
LISTEN_AT = 6.37   # seconds into thirdmain.webm where "MARVIN detected · Listening…" appears


def font(size, weight='Bold'):
    f = ImageFont.truetype(str(FONT), size)
    try: f.set_variation_by_name(weight)
    except Exception: pass
    return f


def rounded(img, r):
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.size[0] - 1, img.size[1] - 1), r, fill=255)
    return mask


def paste_panel(canvas, img, x, y, r=22, border=(126, 232, 255), alpha=1.0):
    """Paste a frame with rounded corners, a soft shadow and a thin glowing border."""
    w, h = img.size
    sh = Image.new('L', (w + 80, h + 80), 0)
    ImageDraw.Draw(sh).rounded_rectangle((40, 50, w + 40, h + 50), r, fill=int(150 * alpha))
    canvas.paste((2, 6, 18), (x - 40, y - 40), sh.filter(ImageFilter.GaussianBlur(22)))
    m = rounded(img, r)
    if alpha < 1: m = m.point(lambda v: int(v * alpha))
    canvas.paste(img, (x, y), m)
    ov = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(ov).rounded_rectangle((0, 0, w - 1, h - 1), r, outline=border + (int(170 * alpha),), width=2)
    canvas.paste(ov, (x, y), ov)


def title_layer(text, sub):
    """Top-left title: accent bar + kicker + heading, pre-rendered once."""
    lay = Image.new('RGBA', (1100, 150), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    d.rounded_rectangle((0, 22, 7, 118), 4, fill=(95, 230, 255, 255))
    d.text((30, 14), sub.upper(), font=font(24, 'SemiBold'), fill=(158, 239, 255, 255), spacing=0)
    d.text((28, 46), text, font=font(66), fill=(243, 251, 255, 255))
    return lay


def ease(x):
    x = min(1, max(0, x))
    return x * x * (3 - 2 * x)


def lerp(a, b, k): return a + (b - a) * k


# Latest Transcript box in the 1850×1008 screen recording: the "--" placeholder sits at (722..760, 830..856).
TX_BOX = (722, 828, 770, 858)


TX_FONT = font(25)


def transcript_listening(img):
    """Replace the "--" placeholder in the Latest Transcript box with "Listening…"."""
    x0, y0, x1, y1 = TX_BOX
    w = x1 - x0
    img.paste(img.crop((x1 + 10, y0, x1 + 10 + w, y1)), (x0, y0))  # cover "--" with the box fill beside it
    ImageDraw.Draw(img).text((x0 + 4, y0 + 1), 'Listening…', font=TX_FONT, fill=(46, 214, 120))
    return img


def split_section(main, phone, title, sub, path, listen_from=None, lead=None):
    """lead = (clip, start, seconds): play that clip on the left first, beside the start of the phone clip."""
    dm, dp = probe_duration(main), probe_duration(phone)
    lead_s = lead[2] if lead else 0.0
    dm += lead_s
    n_total, n_phone = int(round(dm * FPS)), int(round(dp * FPS))
    # Side-by-side layout: screen recording on the left, phone clip (rotated to landscape) on the right, same height.
    M, GAP = 40, 24
    a_main, a_ph = 1850 / 1008, 850 / 472
    ph_h = mh = int((W - 2 * M - GAP) / (a_main + a_ph))
    mw, ph_w = int(mh * a_main), int(ph_h * a_ph)
    mx = (W - mw - GAP - ph_w) // 2
    ph_x = mx + mw + GAP
    my = (H - mh) // 2 + 40
    full_h = int(W * 1008 / 1850)
    full = (0, (H - full_h) // 2, W, full_h)
    tl = title_layer(title, sub)
    mains = frames(main, 1850, 1008)
    if lead: mains = itertools.chain(frames(lead[0], 1850, 1008, ss=lead[1], t=lead[2]), mains)
    phones = frames(phone, ph_w, ph_h, rotate=True)
    enc = encoder(path, audio=phone)
    last_phone = None
    for i in range(n_total):
        t = i / FPS
        m = next(mains, None)
        if m is None: break
        if listen_from is not None and t - lead_s >= listen_from: m = transcript_listening(m)
        p = next(phones, None) if i < n_phone else None
        if p is not None: last_phone = p
        # 0 = split, 1 = full screen: open from full screen at the start, close back after the phone clip ends.
        k = max(1 - ease(t / CLOSE), ease((t - dp) / CLOSE))
        intro = ease((t - .15) / .45)        # phone panel and title slide in
        c = BG.copy()
        x = int(lerp(mx, full[0], k)); y = int(lerp(my, full[1], k))
        w = int(lerp(mw, full[2], k)); h = int(lerp(mh, full[3], k))
        paste_panel(c, m.resize((w, h), Image.LANCZOS), x, y, r=int(lerp(22, 0, k)), alpha=1.0)
        if k < 1 and last_phone is not None and intro > 0:
            px = int(ph_x + (1 - intro) * 80 + k * (W - ph_x + 40))
            paste_panel(c, last_phone, px, my, r=22, border=(140, 240, 196), alpha=intro * (1 - k))
        ta = intro * (1 - k)
        if ta > .01:
            lay = tl.copy(); lay.putalpha(lay.getchannel('A').point(lambda v: int(v * ta)))
            c.paste(lay, (mx, my - 190 - int((1 - intro) * 20)), lay)
        enc.stdin.write(c.tobytes())
        if i % 60 == 0: print(f'{path.name}: {i}/{n_total}', flush=True)
    enc.stdin.close(); enc.wait()


def full_section(src, path, duration=None):
    """Re-encode a screen recording to 1920×1080 / 30 fps on the same background, with silent audio."""
    fh = int(W * 1008 / 1850)
    subprocess.run([ENC_FFMPEG, '-y', '-loglevel', 'error', *HW_IN, *(['-t', str(duration)] if duration else []), '-i', str(src), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
                    '-filter_complex', f'[0:v]fps={FPS},scale={W}:{fh}:flags=lanczos,pad={W}:{H}:0:(oh-ih)/2:color=0x070e20,format=yuv420p{UPLOAD}[v]',
                    '-map', '[v]', '-map', '1:a', '-shortest', *VCODEC,
                    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', str(path)], check=True)
    print(f'{path.name}: done', flush=True)


def main():
    OUT.mkdir(exist_ok=True)
    parts = [OUT / f'part{i}.mp4' for i in range(4)]
    if '--join' in sys.argv: return join(parts)
    full_section(HERE / 'first.webm', parts[0], duration=FIRST_CUT - PHONE_LEAD)
    split_section(HERE / 'secondmain.webm', HERE / 'second.mp4', 'With noise', 'Real-world test · ESP32 + live dashboard', parts[1],
                  lead=(HERE / 'first.webm', FIRST_CUT - PHONE_LEAD, PHONE_LEAD))
    full_section(HERE / 'last.webm', parts[2])
    split_section(HERE / 'thirdmain.webm', HERE / 'third.mp4', 'Hard negatives', 'Look-alike words must not trigger', parts[3],
                  listen_from=LISTEN_AT)
    join(parts)


def join(parts):
    final = OUT / 'MARVIN_demo_edit_1080p.mp4'
    inputs = sum((['-i', str(p)] for p in parts), [])
    # Normalise every part first so concat sees identical streams.
    norm = ''.join(f'[{i}:v]fps={FPS},scale={W}:{H},setsar=1,format=yuv420p[v{i}];[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo[a{i}];' for i in range(len(parts)))
    graph = norm + ''.join(f'[v{i}][a{i}]' for i in range(len(parts))) + f'concat=n={len(parts)}:v=1:a=1[v][a]'
    graph = graph.replace('[v][a]', f'[vc][a]') + f';[vc]null{UPLOAD}[v]'
    subprocess.run([ENC_FFMPEG, '-y', '-loglevel', 'error', *HW_IN, *inputs, '-filter_complex', graph, '-map', '[v]', '-map', '[a]',
                    *VCODEC, '-c:a', 'aac', '-b:a', '192k',
                    '-movflags', '+faststart', str(final)], check=True)
    print('DONE', final, '(GPU h264_vaapi)' if GPU else '(CPU x264)')


if __name__ == '__main__':
    main()
