#pragma once
#include <cstddef>
#include <cstdint>

// Generated from models/marvin_v4/marvin_v4_config.json. These values are frozen.
namespace marvin {
constexpr char kModelVersion[] = "MARVIN_V4_INT8";
constexpr int kSampleRate = 16000;
constexpr int kSamples = 16000;
constexpr int kFrames = 98;
constexpr int kMels = 24;
constexpr int kFrameLength = 400;
constexpr int kFrameStep = 160;
constexpr int kFftLength = 512;
constexpr float kFmin = 80.0f;  // Baseline cascade (marvin_wider) requires 80 Hz.
constexpr float kFmax = 7600.0f;
constexpr float kTrainMean = -10.106344223022461f;
constexpr float kTrainStd = 3.264474868774414f;
constexpr float kStage1Threshold = 0.14f;
constexpr float kStage2Threshold = 0.38f;
constexpr uint32_t kStage1Parameters = 2233;
constexpr uint32_t kStage2Parameters = 9873;
constexpr uint32_t kTotalParameters = 12106;
constexpr size_t kStage1ModelBytes = 10208;
constexpr size_t kStage2ModelBytes = 24456;
// 640 ms is an exact 64-frame advance at the 10 ms feature stride. Live 400 ms
// testing measured 8.85% duty; this is the smallest practical hop below 8%.
constexpr uint32_t kHopSamples = 10240;
constexpr uint32_t kCooldownMs = 1500;
}
