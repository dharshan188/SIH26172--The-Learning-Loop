#!/usr/bin/env python3
import argparse
import json
import time
import wave

import numpy as np
from faster_whisper import WhisperModel

MODEL = "Systran/faster-distil-whisper-large-v3"

parser = argparse.ArgumentParser()
parser.add_argument("wav")
args = parser.parse_args()

with wave.open(args.wav, "rb") as wav:
    channels, width, rate, frames = wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()
    pcm = wav.readframes(frames)
if (channels, width, rate) != (1, 2, 16000):
    raise SystemExit(f"Expected PCM16 mono 16 kHz, got channels={channels}, width={width}, rate={rate}")
samples = np.frombuffer(pcm, dtype="<i2")
model = WhisperModel(MODEL, device="cpu", compute_type="int8")
started = time.perf_counter()
segments, _ = model.transcribe(
    args.wav, language="en", task="transcribe", beam_size=5,
    condition_on_previous_text=False, vad_filter=True,
)
text = " ".join(segment.text.strip() for segment in segments).strip()
print(json.dumps({
    "model": MODEL, "wav": args.wav, "duration_s": frames / rate,
    "sample_count": frames, "peak": float(np.max(np.abs(samples.astype(np.int32))) / 32768),
    "rms": float(np.sqrt(np.mean(np.square(samples.astype(np.float64)))) / 32768),
    "transcript": text, "latency_ms": round((time.perf_counter() - started) * 1000),
}, indent=2))
if not text:
    raise SystemExit("ASR returned an empty transcript")
