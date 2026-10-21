#!/usr/bin/env python3
"""Compare the actual C++ frontend to training's TensorFlow preprocessing.
Run in a venv containing tensorflow-cpu and numpy; needs g++.
"""
import pathlib
import subprocess
import tempfile
import numpy as np
import tensorflow as tf

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'arduino' / 'MarvinWakeWord'

def reference(audio):
    x = tf.convert_to_tensor(audio, tf.float32)
    x = x - tf.reduce_mean(x)
    x = tf.concat([x[:1], x[1:] - tf.constant(0.97, tf.float32) * x[:-1]], 0)
    stft = tf.signal.stft(x, 400, 160, fft_length=512)
    power = tf.abs(stft) ** 2
    weights = tf.signal.linear_to_mel_weight_matrix(24, 257, 16000, 80, 7600)
    mel = tf.matmul(power, weights)
    features = (tf.clip_by_value(tf.math.log(mel + 1e-6), -12, 4) + 4) / 8
    quantized = tf.cast(tf.clip_by_value(tf.round(features / np.float32(0.007843137718737125) - 1), -128, 127), tf.int8)
    return features.numpy(), quantized.numpy()

rng = np.random.default_rng(42)
time = np.arange(16000, dtype=np.float32) / 16000
cases = {
    'silence': np.zeros(16000, np.float32),
    'dc': np.full(16000, 0.125, np.float32),
    'tone_440': (0.1 * np.sin(2 * np.pi * 440 * time)).astype(np.float32),
    'tone_1000': (0.3 * np.sin(2 * np.pi * 1000 * time)).astype(np.float32),
    'noise': rng.uniform(-0.1, 0.1, 16000).astype(np.float32),
    'quiet_noise': rng.uniform(-1e-4, 1e-4, 16000).astype(np.float32),
    'full_scale_noise': rng.uniform(-1, 1, 16000).astype(np.float32),
    'impulse': np.eye(1, 16000, 37, dtype=np.float32)[0],
}
with tempfile.TemporaryDirectory(prefix='marvin-parity-') as temp:
    work = pathlib.Path(temp)
    harness = work / 'main.cpp'
    harness.write_text('''#include "frontend.h"
#include <cstdio>
static marvin::Frontend frontend;
static float audio[16000], features[2352];
static int8_t q[2352];
int main() {
 if (std::fread(audio, sizeof(float), 16000, stdin) != 16000) return 1;
 frontend.begin(); frontend.compute(audio, q, features);
 std::fwrite(features, sizeof(float), 2352, stdout);
 std::fwrite(q, sizeof(int8_t), 2352, stdout);
}
''')
    executable = work / 'frontend'
    subprocess.run(['g++', '-std=c++17', '-O2', '-ffp-contract=off', '-I', str(SOURCE), str(harness), str(SOURCE/'frontend.cpp'), '-o', str(executable)], check=True)
    for name, audio in cases.items():
        out = subprocess.run([str(executable)], input=audio.tobytes(), capture_output=True, check=True).stdout
        actual = np.frombuffer(out[:2352*4], np.float32).reshape(98, 24)
        q_actual = np.frombuffer(out[2352*4:], np.int8).reshape(98, 24)
        expected, q_expected = reference(audio)
        error = float(np.max(np.abs(actual - expected)))
        q_error = np.abs(q_actual.astype(np.int16) - q_expected.astype(np.int16))
        print(f'{name:18s} max_float_error={error:.9g} int8_differences={np.count_nonzero(q_error)}/2352 max_int8_error={q_error.max()}')
        # Floating-point FFT/reduction/log implementations need not be bit-identical.
        assert error < 2e-4, (name, error)
        assert q_error.max() <= 1, (name, q_error.max())
    print('PASS: TensorFlow frontend parity within float tolerance; INT8 error <= 1 LSB.')
