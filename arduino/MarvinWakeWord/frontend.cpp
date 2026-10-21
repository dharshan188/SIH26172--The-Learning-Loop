#include "frontend.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <esp_dsp.h>

namespace marvin {
namespace {
constexpr float kPi = 3.14159265358979323846f;
float hzToMel(float hz) { return 1127.0f * std::log(1.0f + hz / 700.0f); }
int roundEven(float value) {
  const float floorValue = std::floor(value);
  int result = static_cast<int>(floorValue);
  const float fraction = value - floorValue;
  if (fraction > 0.5f || (fraction == 0.5f && (result & 1))) ++result;
  return result;
}
}

void Frontend::begin() {
  // tf.signal.hann_window(400, periodic=True)
  for (int n = 0; n < kFrameLength; ++n)
    window_[n] = 0.5f - 0.5f * std::cos(2.0f * kPi * n / kFrameLength);
  dsps_fft2r_init_fc32(nullptr, kFftLength);
  float edges[kMels + 2];
  const float low = hzToMel(kFmin), high = hzToMel(kFmax);
  for (int b = 0; b < kMels + 2; ++b)
    edges[b] = low + (high - low) * b / (kMels + 1);
  for (int k = 0; k <= kFftLength / 2; ++k) {
    bands_[k][0] = bands_[k][1] = -1;
    weights_[k][0] = weights_[k][1] = 0.0f;
    if (k == 0) continue;
    const float mel = hzToMel(k * (static_cast<float>(kSampleRate) / kFftLength));
    int slot = 0;
    for (int b = 0; b < kMels; ++b) {
      const float rising = (mel - edges[b]) / (edges[b + 1] - edges[b]);
      const float falling = (edges[b + 2] - mel) / (edges[b + 2] - edges[b + 1]);
      const float weight = std::max(0.0f, std::min(rising, falling));
      if (weight > 0.0f && slot < 2) {
        bands_[k][slot] = b;
        weights_[k][slot++] = weight;
      }
    }
  }
}

void Frontend::computeFrame(const int16_t* pcm16, int frame, float mean, int8_t* output,
                            float inputScale, int inputZero) {
    for (int n = 0; n < kFftLength; ++n) {
      if (n < kFrameLength) {
        const int idx = frame * kFrameStep + n;
        const float centered = static_cast<float>(pcm16[idx]) / 32768.0f - mean;
        float prev = 0.0f;
        if (idx > 0) prev = static_cast<float>(pcm16[idx - 1]) / 32768.0f - mean;
        const float emphasized = (idx > 0) ? centered - 0.97f * prev : centered;
        fftData_[2 * n] = emphasized * window_[n];
      } else {
        fftData_[2 * n] = 0.0f;
      }
      fftData_[2 * n + 1] = 0.0f;
    }
    dsps_fft2r_fc32(fftData_, kFftLength);
    dsps_bit_rev_fc32(fftData_, kFftLength);
    dsps_cplx2reC_fc32(fftData_, kFftLength);
    float energies[kMels] = {};
    for (int k = 0; k <= kFftLength / 2; ++k) {
      // cplx2reC produces bins 0..N/2-1. Nyquist has no Mel weight here.
      const float real = k < kFftLength / 2 ? fftData_[2 * k] : 0.0f;
      const float imag = k < kFftLength / 2 ? fftData_[2 * k + 1] : 0.0f;
      const float power = real * real + imag * imag;
      for (int slot = 0; slot < 2; ++slot)
        if (bands_[k][slot] >= 0)
          energies[bands_[k][slot]] += power * weights_[k][slot];
    }
    for (int band = 0; band < kMels; ++band) {
      const float logmel = std::max(-12.0f, std::min(4.0f, std::log(energies[band] + 1e-6f)));
      const float normalized = (logmel + 4.0f) / 8.0f;
      const int quantized = roundEven(normalized / inputScale + inputZero);
      output[frame * kMels + band] = static_cast<int8_t>(
          std::max(-128, std::min(127, quantized)));
    }
}

void Frontend::computeRolling(const int16_t* pcm16, int8_t* output,
                              float inputScale, int inputZero) {
  double sum = 0.0;
  for (int n = 0; n < kSamples; ++n) sum += pcm16[n];
  const float mean = static_cast<float>(sum / (32768.0 * kSamples));
  constexpr int kNewFrames = kHopSamples / kFrameStep;
  int firstFrame = 0;
  if (primed_) {
    memmove(output, output + kNewFrames * kMels,
            (kFrames - kNewFrames) * kMels * sizeof(output[0]));
    firstFrame = kFrames - kNewFrames;
  }
  for (int frame = firstFrame; frame < kFrames; ++frame)
    computeFrame(pcm16, frame, mean, output, inputScale, inputZero);
  primed_ = true;
}
}  // namespace marvin
