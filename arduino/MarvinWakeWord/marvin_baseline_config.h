#pragma once
#include <cstddef>
#include <cstdint>

// Frozen MARVIN baseline cascade (replaces V4 wiring in firmware).
// Stage 1: marvin_wider_int8.tflite + appended explicit 25x48 feature output.
// Stage 2: marvin_stage2_temporal_int8.tflite consumes that feature directly.
namespace baseline {
constexpr char kModelVersion[] = "MARVIN_BASELINE_CASCADE";
constexpr float kStage1Threshold = 0.46484375f;
constexpr float kStage2Threshold = 0.54f;
constexpr size_t kStage1ModelBytes = 17268;  // 17256 + 12 dual-output patch.
constexpr size_t kStage1OrigBytes = 17256;
constexpr size_t kStage2ModelBytes = 11056;
constexpr int kFeatD0 = 1, kFeatD1 = 25, kFeatD2 = 48;
constexpr size_t kFeatBytes = 1200;
constexpr float kFeatScale = 0.04730948060750961f;
constexpr int kFeatZero = -128;
constexpr float kS1InScale = 0.007843137718737125f;
constexpr int kS1InZero = -1;
constexpr float kOutScale = 0.00390625f;
constexpr int kOutZero = -128;
}
