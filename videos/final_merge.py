"""Merge the final MARVIN video:

  3D intro (last 2 s cut) → "Next · Prototype" → demo (first, With noise split, model comparison)
  → "Next · Words with similar sound" → Hard negatives split → "Next · Impact & Feasibility" → Impact video

Every join is a short crossfade. Cards are 2 s, rendered here in the 3D video's style.
Uses the demo parts built by edit_split.py (out/part0..3.mp4); run that first.

  python3 final_merge.py           -> out/MARVIN_SIH2026_FULL_1080p.mp4
"""
import subprocess
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from edit_split import (ENC_FFMPEG, FFMPEG, FPS, GPU, H, HW_IN, UPLOAD, VCODEC, W, OUT, HERE, ease, font, probe_duration)

VIDEO = HERE.parent / 'video' / 'out'
INTRO, INTRO_CUT = VIDEO / 'MARVIN_SIH2026_3D_1080p.mp4', 2.0
IMPACT = VIDEO / 'MARVIN_SIH2026_Impact_1080p.mp4'
CARD = 2.0   # seconds per "Next" card
XF = 0.3     # crossfade between segments


def card_bg():
    """Deep-blue gradient with soft bokeh, like the 3D video."""
    k = np.linspace(0, 1, H)[:, None, None]
    g = (np.array((30, 62, 112)) * (1 - k) + np.array((10, 24, 56)) * k).astype(np.uint8)
    img = Image.fromarray(np.repeat(g, W, axis=1))
    bok = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(bok)
    rng = np.random.default_rng(7)
    for _ in range(26):
        x, y, r = rng.integers(0, W), rng.integers(0, H), rng.integers(14, 70)
        col = (255, 140, 120, 40) if rng.random() < .35 else (120, 200, 255, 34)
        d.ellipse((x - r, y - r, x + r, y + r), fill=col)
    img.paste(bok.filter(ImageFilter.GaussianBlur(6)), (0, 0), bok.filter(ImageFilter.GaussianBlur(6)))
    glow = Image.new('L', (W, H), 0)
    ImageDraw.Draw(glow).ellipse((W // 2 - 520, H // 2 - 300, W // 2 + 520, H // 2 + 300), fill=70)
    img.paste((90, 200, 255), (0, 0), glow.filter(ImageFilter.GaussianBlur(160)))
    return img


def centered(d, y, text, f, fill, tracking=0):
    if tracking:
        widths = [d.textlength(ch, font=f) for ch in text]
        x = (W - sum(widths) - tracking * (len(text) - 1)) / 2
        for ch, w in zip(text, widths):
            d.text((x, y), ch, font=f, fill=fill); x += w + tracking
    else:
        d.text(((W - d.textlength(text, font=f)) / 2, y), text, font=f, fill=fill)


def make_card(title, sub, path):
    bg = card_bg()
    txt = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(txt)
    centered(d, 400, 'NEXT', font(30, 'SemiBold'), (126, 232, 255, 255), tracking=14)
    centered(d, 452, title, font(112), (243, 251, 255, 255))
    centered(d, 608, sub, font(34, 'Medium'), (175, 205, 235, 255))
    line = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    enc = subprocess.Popen([ENC_FFMPEG, '-y', '-loglevel', 'error', *HW_IN, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}',
                            '-r', str(FPS), '-i', '-', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', str(CARD),
                            *(['-vf', UPLOAD.lstrip(',')] if GPU else []), *VCODEC, '-c:a', 'aac', '-b:a', '192k', str(path)],
                           stdin=subprocess.PIPE)
    for i in range(int(CARD * FPS)):
        t = i / FPS
        a = ease((t - .1) / .45)
        c = bg.copy()
        # accent line grows under the kicker
        ll = int(220 * ease((t - .05) / .5))
        line = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(line).rounded_rectangle((W // 2 - ll // 2, 584, W // 2 + ll // 2, 589), 3, fill=(95, 230, 255, 230))
        c.paste(line, (0, 0), line)
        lay = txt.copy(); lay.putalpha(lay.getchannel('A').point(lambda v: int(v * a)))
        c.paste(lay, (0, int((1 - a) * 24)), lay)
        enc.stdin.write(c.tobytes())
    enc.stdin.close(); enc.wait()


def main():
    cards = {
        'prototype': ('Prototype', 'Live demo · ESP32 + real-time dashboard'),
        'similar': ('Words with similar sound', 'Look-alike words must not trigger MARVIN'),
        'impact': ('Impact & Feasibility', 'Who benefits, and why it is buildable today'),
    }
    for key, (title, sub) in cards.items():
        make_card(title, sub, OUT / f'card_{key}.mp4')
        print('card', key, 'done', flush=True)

    # (path, duration to use, has audio)
    segs = [(INTRO, probe_duration(INTRO) - INTRO_CUT, False),
            (OUT / 'card_prototype.mp4', CARD, True),
            (OUT / 'part0.mp4', None, True), (OUT / 'part1.mp4', None, True), (OUT / 'part2.mp4', None, True),
            (OUT / 'card_similar.mp4', CARD, True),
            (OUT / 'part3.mp4', None, True),
            (OUT / 'card_impact.mp4', CARD, True),
            (IMPACT, probe_duration(IMPACT), False)]
    segs = [(p, d if d else probe_duration(p), a) for p, d, a in segs]

    inputs, graph = [], []
    for i, (p, d, has_a) in enumerate(segs):
        inputs += ['-t', f'{d:.3f}', '-i', str(p)]
        graph.append(f'[{i}:v]fps={FPS},scale={W}:{H},setsar=1,format=yuv420p,trim=0:{d:.3f},setpts=PTS-STARTPTS[v{i}]')
        if has_a:
            graph.append(f'[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=0:{d:.3f},asetpts=PTS-STARTPTS[a{i}]')
        else:
            graph.append(f'anullsrc=r=48000:cl=stereo,atrim=0:{d:.3f}[a{i}]')
    v, a, total = 'v0', 'a0', segs[0][1]
    for i in range(1, len(segs)):
        off = total - XF
        graph.append(f'[{v}][v{i}]xfade=transition=fade:duration={XF}:offset={off:.3f}[vx{i}]')
        graph.append(f'[{a}][a{i}]acrossfade=d={XF}[ax{i}]')
        v, a, total = f'vx{i}', f'ax{i}', total + segs[i][1] - XF
    graph.append(f'[{v}]null{UPLOAD}[vout]')
    final = OUT / 'MARVIN_SIH2026_FULL_1080p.mp4'
    subprocess.run([ENC_FFMPEG, '-y', '-loglevel', 'error', *HW_IN, *inputs, '-filter_complex', ';'.join(graph),
                    '-map', '[vout]', '-map', f'[{a}]', *VCODEC, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
                    str(final)], check=True)
    print('DONE', final, f'{total:.1f}s', '(GPU h264_vaapi)' if GPU else '(CPU x264)')


if __name__ == '__main__':
    main()
