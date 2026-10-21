#pragma once
#include <cstddef>
#include <cstdint>

// Frozen MARVIN best INT8 deployment (replaces cascade wiring in firmware).
// Values verified from marvin_best_model/config + FINAL_REPORT.txt.
namespace best {
constexpr char kModelVersion[] = "MARVIN_BEST_INT8";
constexpr char kArchitecture[] = "DS-CNN + Tiny Temporal Transformer";
constexpr size_t kModelBytes = 53824;  // patched: 53712 + 112 custom BatchMatMul opcode.
constexpr size_t kOrigModelBytes = 53712;
constexpr uint32_t kParameters = 20734;
constexpr uint32_t kMacs = 1283176;
constexpr float kPrecision = 0.9425287356321839f;  // INT8 validation.
constexpr float kRecall = 0.8631578947368421f;
constexpr float kF1 = 0.901098901098901f;
// Deployed decision: calibrated = clip(raw + shift, 0, 1); trigger >= 0.60.
constexpr float kThreshold = 0.60f;
constexpr float kCalibShift = -0.05234375f;
constexpr float kInScale = 0.006916360463947058f;
constexpr int kInZero = -18;
constexpr float kOutScale = 0.00390625f;
constexpr int kOutZero = -128;
constexpr int kFeatFrames = 98;
constexpr int kFeatMels = 32;
constexpr size_t kFeatBytes = 98 * 32;
}  // namespace best
