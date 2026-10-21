#pragma once
#include <cstdint>
#include "marvin_kws_config.h"

namespace marvin {
class Frontend {
 public:
  void begin();
  // The first call creates all 98 frames. Later calls roll by kHopSamples and
  // calculate only the 40 newly-arrived frames.
  void computeRolling(const int16_t* pcm16, int8_t* output, float inputScale, int inputZero);
  // Forces the next computeRolling() to rebuild all 98 frames (used when
  // the frontend is skipped between gated inferences).
  void reset() { primed_ = false; }
 private:
  void computeFrame(const int16_t* pcm16, int frame, float mean, int8_t* output,
                    float inputScale, int inputZero);
  bool primed_ = false;
  float window_[kFrameLength];
  // ESP-DSP complex, interleaved scratch buffer. Allocated once in .bss.
  float fftData_[kFftLength * 2];
  float weights_[kFftLength / 2 + 1][2];
  int8_t bands_[kFftLength / 2 + 1][2];
};
}
