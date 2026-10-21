#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <U8g2lib.h>
#include <Chirale_TensorFlowLite.h>
#include <tensorflow/lite/micro/micro_interpreter.h>
#include <tensorflow/lite/micro/micro_mutable_op_resolver.h>
#include <tensorflow/lite/schema/schema_generated.h>
#include <driver/i2s_std.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <mbedtls/base64.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <cmath>
#include <cstring>
#include "frontend.h"
#include "marvin_kws_config.h"
#include "marvin_baseline_config.h"
#include "marvin_cascade_s1.h"
#include "marvin_cascade_s2.h"
#include "wifi_config.h"

constexpr size_t kStage1ArenaBytes = 16 * 1024;
constexpr size_t kStage2ArenaBytes = 8 * 1024;
constexpr uint32_t kHeapCaps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
alignas(16) static uint8_t stage1Arena[kStage1ArenaBytes];
alignas(16) static uint8_t stage2Arena[kStage2ArenaBytes];
static int16_t* audio[2] = {};
static marvin::Frontend frontend;
static tflite::MicroInterpreter* stage1Interpreter;
static tflite::MicroInterpreter* stage2Interpreter;
static TfLiteTensor *stage1Input, *stage1Output, *stage1Feature, *stage2Input, *stage2Output;
static i2s_chan_handle_t rx;
static WebSocketsClient audioWs;
static bool audioWsConfigured;
static char asrHost[64];
static U8G2_SH1106_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);
static bool oledPresent;
static uint32_t transcriptUntilMs;
static uint32_t listeningAtMs;
static bool listeningPending;
static bool asrSessionActive;
static uint32_t asrSessionStartMs;

static void oledIdle() {
  if (!oledPresent) return;
  oled.clearBuffer();
  oled.setFont(u8g2_font_helvB12_tr);
  constexpr char text[] = "MARVIN READY";
  oled.drawStr((128 - oled.getStrWidth(text)) / 2, 39, text);
  oled.sendBuffer();
}

static void oledListening() {
  if (!oledPresent) return;
  transcriptUntilMs = 0;
  oled.clearBuffer();
  oled.setFont(u8g2_font_helvB10_tr);
  oled.drawStr(30, 25, "MARVIN");
  oled.drawStr(25, 45, "DETECTED");
  oled.sendBuffer();
  listeningAtMs = millis() + 450;
  listeningPending = true;
}

static void oledShowListening() {
  if (!oledPresent) return;
  oled.clearBuffer();
  oled.setFont(u8g2_font_helvB10_tr);
  constexpr char message[] = "Listening...";
  oled.drawStr((128 - oled.getStrWidth(message)) / 2, 37, message);
  oled.sendBuffer();
}

static void oledTranscript(const uint8_t* bytes, size_t length) {
  if (!oledPresent) return;
  listeningPending = false;
  constexpr size_t kMaxText = 104;
  char text[kMaxText + 1];
  length = std::min(length, kMaxText);
  for (size_t i = 0; i < length; ++i)
    text[i] = bytes[i] >= 32 && bytes[i] <= 126 ? char(bytes[i]) : ' ';
  text[length] = '\0';
  if (!length) { transcriptUntilMs = 0; oledIdle(); return; }
  oled.clearBuffer();
  oled.setFont(u8g2_font_6x10_tr);
  oled.drawStr(0, 10, "Transcript:");
  if (length <= 11) {
    oled.setFont(u8g2_font_helvB14_tr);
    const uint8_t width = oled.getStrWidth(text);
    if (width <= 124) {
      oled.drawStr((128 - width) / 2, 44, text);
      oled.sendBuffer();
      transcriptUntilMs = millis() + 5000;
      return;
    }
  }
  const bool medium = length <= 32;
  oled.setFont(medium ? u8g2_font_helvB10_tr : u8g2_font_6x10_tr);
  const uint8_t maxLines = medium ? 3 : 5;
  const uint8_t firstBaseline = medium ? 29 : 20;
  const uint8_t lineHeight = medium ? 16 : 10;
  char* p = text;
  for (uint8_t line = 0; line < maxLines && *p; ++line) {
    while (*p == ' ') ++p;
    const size_t remain = strlen(p);
    size_t take = 0, lastSpace = 0;
    for (size_t i = 1; i <= remain; ++i) {
      const char saved = p[i]; p[i] = '\0';
      const bool fits = oled.getStrWidth(p) <= 124;
      p[i] = saved;
      if (!fits) break;
      take = i;
      if (p[i - 1] == ' ') lastSpace = i - 1;
    }
    if (take < remain && lastSpace) take = lastSpace;
    if (!take) take = 1;
    char saved = p[take]; p[take] = '\0';
    oled.drawStr(0, firstBaseline + line * lineHeight, p);
    p[take] = saved;
    p += take; while (*p == ' ') ++p;
  }
  oled.sendBuffer();
  transcriptUntilMs = millis() + 5000;
}

constexpr uint32_t kFollowingSpeechSamples = 3 * marvin::kSampleRate;
constexpr uint16_t kPcmChunkSamples = 1024;
struct PcmChunk { uint16_t samples; int16_t pcm[kPcmChunkSamples]; };
static StaticQueue_t pcmQueueState;
static uint8_t pcmQueueStorage[8 * sizeof(PcmChunk)];
static QueueHandle_t pcmQueue;
static volatile uint32_t asrSamplesRemaining;
static volatile bool asrCaptureDone;
static volatile uint32_t asrDroppedChunks;
static uint32_t asrAudioBytesSent;
static uint32_t asrWireBytesSent;
static uint8_t adpcmPacket[6 + (kPcmChunkSamples + 1) / 2];

static bool sendAdpcm(const int16_t* pcm, uint16_t samples) {
  static constexpr uint16_t steps[89] = {
      7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,
      80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,
      494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,
      2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,
      8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,
      27086,29794,32767};
  static constexpr int8_t changes[16] = {-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8};
  adpcmPacket[0] = samples & 0xff;
  adpcmPacket[1] = samples >> 8;
  adpcmPacket[2] = adpcmPacket[3] = adpcmPacket[4] = adpcmPacket[5] = 0;
  int predictor = 0, index = 0;
  for (uint16_t i = 0; i < samples; ++i) {
    const int step = steps[index];
    int diff = int(pcm[i]) - predictor;
    uint8_t code = 0;
    if (diff < 0) { code = 8; diff = -diff; }
    int delta = step >> 3;
    if (diff >= step) { code |= 4; diff -= step; delta += step; }
    if (diff >= (step >> 1)) { code |= 2; diff -= step >> 1; delta += step >> 1; }
    if (diff >= (step >> 2)) { code |= 1; delta += step >> 2; }
    predictor += (code & 8) ? -delta : delta;
    predictor = std::max(-32768, std::min(32767, predictor));
    index = std::max(0, std::min(88, index + changes[code]));
    if (!(i & 1)) adpcmPacket[6 + i / 2] = code;
    else adpcmPacket[6 + i / 2] |= code << 4;
  }
  const size_t wireBytes = 6 + (samples + 1) / 2;
  if (!audioWs.sendBIN(adpcmPacket, wireBytes)) return false;
  asrAudioBytesSent += samples * sizeof(int16_t);
  asrWireBytesSent += wireBytes;
  return true;
}

static void audioWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  if (type == WStype_TEXT && length >= 11 && memcmp(payload, "TRANSCRIPT:", 11) == 0) {
    Serial.printf("ESP32_TRANSCRIPT_RECEIVED:%.*s\n", int(std::min<size_t>(length - 11, 150)), payload + 11);
    asrSessionActive = false;
    oledTranscript(payload + 11, length - 11);
  } else if (type == WStype_DISCONNECTED && asrSessionActive) {
    Serial.printf("ASR_STREAM_LOST bytes=%u dropped_chunks=%u\n", unsigned(asrAudioBytesSent), unsigned(asrDroppedChunks));
    asrSamplesRemaining = 0;
    asrCaptureDone = false;
    asrSessionActive = false;
    listeningPending = false;
    xQueueReset(pcmQueue);
    oledIdle();
  }
}

struct AudioWindow {
  int index;
  uint32_t sequence;
  uint32_t dmaOverflows;
  uint32_t skippedWindows;
  float peak;
  float rightRms;
  float leftRms;
};
static StaticQueue_t freeQueueState, readyQueueState;
static uint8_t freeQueueStorage[sizeof(int)];
static uint8_t readyQueueStorage[sizeof(AudioWindow)];
static QueueHandle_t freeQueue, readyQueue;
static StaticTask_t captureTaskState;
static StackType_t captureStack[4096 / sizeof(StackType_t)];
// A single replaceable PCM preview from the existing capture path. The sender
// runs below the microphone task's priority and never makes capture wait.
struct PreviewChunk { int16_t pcm[512]; };
static StaticQueue_t previewQueueState;
static uint8_t previewQueueStorage[sizeof(PreviewChunk)];
static QueueHandle_t previewQueue;
static StaticTask_t previewTaskState;
static StackType_t previewStack[3072 / sizeof(StackType_t)];
static uint32_t dmaOverflows;
static portMUX_TYPE overflowMux = portMUX_INITIALIZER_UNLOCKED;
static size_t heapBeforeInit;
static size_t heapBaseline;
static uint32_t stage1Runs, stage2Runs, wakeCount;
static uint32_t statsStartMs, statsS1Runs, statsS2Runs;
static uint64_t totalFeUs, totalS1Us, totalS2Us, statsFeUs, statsS1Us, statsS2Us;
static uint32_t lastWakeMs;
static bool kwsTestActive;
static uint32_t kwsTestDeadlineMs;
static char serialCommand[48];
static size_t serialCommandLength;
extern "C" { extern char _data_start, _data_end, _bss_start, _bss_end; }

static void fatal(const char* message) {
  Serial.printf("FATAL: %s\n", message);
  if (rx) i2s_channel_disable(rx);
  while (true) delay(1000);
}
static void checkEsp(esp_err_t error, const char* operation) {
  if (error != ESP_OK) {
    Serial.printf("I2S_ERROR operation=%s error=%s\n", operation, esp_err_to_name(error));
    fatal("I2S initialization/read failed");
  }
}
static uint32_t readOverflows() {
  portENTER_CRITICAL(&overflowMux);
  const uint32_t value = dmaOverflows;
  portEXIT_CRITICAL(&overflowMux);
  return value;
}
static bool IRAM_ATTR onOverflow(i2s_chan_handle_t, i2s_event_data_t*, void*) {
  portENTER_CRITICAL_ISR(&overflowMux);
  ++dmaOverflows;
  portEXIT_CRITICAL_ISR(&overflowMux);
  return false;
}

static void previewTask(void*) {
  static PreviewChunk chunk;
  static unsigned char encoded[1400];
  for (;;) {
    if (xQueueReceive(previewQueue, &chunk, portMAX_DELAY) != pdTRUE) continue;
    size_t length = 0;
    if (mbedtls_base64_encode(encoded, sizeof(encoded), &length,
                              reinterpret_cast<const unsigned char*>(chunk.pcm), sizeof(chunk.pcm)) == 0) {
      encoded[length] = '\0';
      Serial.printf("MARVIN_AUDIO {\"type\":\"preview\",\"sample_rate\":16000,\"channels\":1,\"bit_depth\":16,\"pcm16le\":\"%s\"}\n", encoded);
    }
  }
}

static void captureTask(void*) {
  int32_t stereo[256 * 2];
  static PcmChunk pcmChunk;
  static PreviewChunk preview;
  int current = 0;
  size_t filled = 0;
  uint32_t sequence = 0, skipped = 0, samplesSinceWindow = 0, previewSamples = 0;
  double leftSum = 0.0, rightSum = 0.0;
  float peak = 0.0f;
  size_t warmup = 1600;
  while (warmup) {
    size_t bytes = 0;
    const size_t frames = std::min<size_t>(warmup, 256);
    checkEsp(i2s_channel_read(rx, stereo, frames * 8, &bytes, 2000), "warmup");
    if (!bytes || bytes % 8) fatal("Invalid I2S warmup frame");
    warmup -= bytes / 8;
  }
  uint32_t previousOverflows = readOverflows();
  for (;;) {
    const size_t target = filled < marvin::kSamples
        ? std::min<size_t>(256, marvin::kSamples - filled)
        : std::min<size_t>(256, marvin::kHopSamples - samplesSinceWindow);
    size_t bytes = 0;
    checkEsp(i2s_channel_read(rx, stereo, target * 8, &bytes, 2000), "capture");
    if (!bytes || bytes % 8) fatal("Incomplete stereo I2S frame");
    const size_t got = bytes / 8;
    for (size_t n = 0; n < got; ++n) {
      const int32_t right24 = stereo[2 * n] >> 8;
      const int32_t left24 = stereo[2 * n + 1] >> 8;
      audio[current][filled++] = static_cast<int16_t>(right24 >> 8);
      const float right = static_cast<float>(right24) / 8388608.0f;
      const float left = static_cast<float>(left24) / 8388608.0f;
      peak = fmaxf(peak, fabsf(right));
      rightSum += static_cast<double>(right) * right;
      leftSum += static_cast<double>(left) * left;
    }
    previewSamples += got;
    if (previewSamples >= 3200 && filled >= 512) {
      memcpy(preview.pcm, audio[current] + filled - 512, sizeof(preview.pcm));
      xQueueOverwrite(previewQueue, &preview);
      previewSamples = 0;
    }
    if (asrSamplesRemaining) {
      const size_t count = std::min<size_t>(got, asrSamplesRemaining);
      for (size_t n = 0; n < count; ++n) {
        pcmChunk.pcm[pcmChunk.samples++] = static_cast<int16_t>((stereo[2 * n] >> 8) >> 8);
        if (pcmChunk.samples == kPcmChunkSamples) {
          if (xQueueSend(pcmQueue, &pcmChunk, 0) != pdTRUE) { ++skipped; asrDroppedChunks += kPcmChunkSamples / 256; }
          pcmChunk.samples = 0;
        }
      }
      asrSamplesRemaining -= count;
      if (!asrSamplesRemaining) {
        if (pcmChunk.samples && xQueueSend(pcmQueue, &pcmChunk, 0) != pdTRUE) {
          ++skipped; asrDroppedChunks += (pcmChunk.samples + 255) / 256;
        }
        pcmChunk.samples = 0;
        asrCaptureDone = true;
      }
    } else if (!asrCaptureDone) {
      pcmChunk.samples = 0;
    }
    samplesSinceWindow += got;
    const bool firstReady = filled == marvin::kSamples && sequence == 0;
    const bool hopReady = filled == marvin::kSamples && sequence > 0 && samplesSinceWindow >= marvin::kHopSamples;
    if (!firstReady && !hopReady) continue;
    const uint32_t overflows = readOverflows();
    int next = -1;
    if (xQueueReceive(freeQueue, &next, 0) == pdTRUE && overflows == previousOverflows) {
      memcpy(audio[next], audio[current] + marvin::kHopSamples,
             (marvin::kSamples - marvin::kHopSamples) * sizeof(int16_t));
      AudioWindow window{current, ++sequence, overflows, skipped, peak,
                         static_cast<float>(sqrt(rightSum / marvin::kSamples)),
                         static_cast<float>(sqrt(leftSum / marvin::kSamples))};
      if (xQueueSend(readyQueue, &window, 0) != pdTRUE) {
        ++skipped;
        xQueueSend(freeQueue, &current, 0);
      }
      current = next;
    } else {
      ++skipped;
      memmove(audio[current], audio[current] + marvin::kHopSamples,
              (marvin::kSamples - marvin::kHopSamples) * sizeof(int16_t));
    }
    previousOverflows = overflows;
    filled = marvin::kSamples - marvin::kHopSamples;
    samplesSinceWindow = 0;
    leftSum = rightSum = 0.0;
    peak = 0.0f;
  }
}

static void setupI2S() {
  i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  channel.dma_desc_num = 4;
  channel.dma_frame_num = 256;
  checkEsp(i2s_new_channel(&channel, nullptr, &rx), "new_channel");
  i2s_std_config_t config = {};
  config.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(marvin::kSampleRate);
  config.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO);
  config.slot_cfg.slot_mask = I2S_STD_SLOT_BOTH;
  config.gpio_cfg.mclk = I2S_GPIO_UNUSED;
  config.gpio_cfg.bclk = GPIO_NUM_14;
  config.gpio_cfg.ws = GPIO_NUM_15;
  config.gpio_cfg.dout = I2S_GPIO_UNUSED;
  config.gpio_cfg.din = GPIO_NUM_32;
  checkEsp(i2s_channel_init_std_mode(rx, &config), "std_mode");
  i2s_event_callbacks_t callbacks = {};
  callbacks.on_recv_q_ovf = onOverflow;
  checkEsp(i2s_channel_register_event_callback(rx, &callbacks, nullptr), "callback");
  checkEsp(i2s_channel_enable(rx), "enable");
}

static void validateStage1(TfLiteTensor* input, TfLiteTensor* prob) {
  if (!input || !prob || input->type != kTfLiteInt8 || prob->type != kTfLiteInt8 ||
      input->dims->size != 3 || input->dims->data[0] != 1 || input->dims->data[1] != 98 ||
      input->dims->data[2] != 24 || input->bytes != 2352 ||
      prob->dims->size != 2 || prob->dims->data[0] != 1 || prob->dims->data[1] != 1 || prob->bytes != 1) {
    Serial.println("MODEL_ERROR model=stage1 reason=tensor_shape_or_type");
    fatal("Stage-1 tensor validation failed");
  }
  Serial.printf("MODEL_QUANT model=stage1 input_scale=%.10f input_zero=%d output_scale=%.8f output_zero=%d\n",
      input->params.scale, input->params.zero_point, prob->params.scale, prob->params.zero_point);
  if (fabsf(input->params.scale - baseline::kS1InScale) > 1e-9f || input->params.zero_point != baseline::kS1InZero ||
      fabsf(prob->params.scale - baseline::kOutScale) > 1e-9f || prob->params.zero_point != baseline::kOutZero)
    fatal("Stage-1 quantization mismatch");
}
// Explicit dual-output feature map; never depend on a reused intermediate pointer.
static void validateHandoff(TfLiteTensor* feature, TfLiteTensor* input) {
  Serial.printf("STAGE1 feature: shape=%dx%dx%d type=int8 bytes=%u\n",
      feature->dims->data[0], feature->dims->data[1], feature->dims->data[2], unsigned(feature->bytes));
  Serial.printf("STAGE2 input: shape=%dx%dx%d type=int8 bytes=%u\n",
      input->dims->data[0], input->dims->data[1], input->dims->data[2], unsigned(input->bytes));
  const bool ok = feature->type == kTfLiteInt8 && input->type == kTfLiteInt8 &&
      feature->dims->size == 3 && input->dims->size == 3 &&
      feature->dims->data[0] == baseline::kFeatD0 && feature->dims->data[1] == baseline::kFeatD1 &&
      feature->dims->data[2] == baseline::kFeatD2 && input->dims->data[0] == baseline::kFeatD0 &&
      input->dims->data[1] == baseline::kFeatD1 && input->dims->data[2] == baseline::kFeatD2 &&
      feature->bytes == baseline::kFeatBytes && input->bytes == baseline::kFeatBytes &&
      fabsf(feature->params.scale - baseline::kFeatScale) < 1e-9f && feature->params.zero_point == baseline::kFeatZero &&
      fabsf(input->params.scale - baseline::kFeatScale) < 1e-9f && input->params.zero_point == baseline::kFeatZero;
  Serial.printf("FEATURE HANDOFF: %s\n", ok ? "COMPATIBLE" : "MISMATCH");
  if (!ok) fatal("Stage1->Stage2 feature handoff mismatch");
}
static float probability(TfLiteTensor* output) {
  return (output->data.int8[0] - output->params.zero_point) * output->params.scale;
}
static size_t staticRamBytes() {
  return (reinterpret_cast<uintptr_t>(&_data_end) - reinterpret_cast<uintptr_t>(&_data_start)) +
         (reinterpret_cast<uintptr_t>(&_bss_end) - reinterpret_cast<uintptr_t>(&_bss_start));
}

static void stopKwsTest(const char* result) {
  if (!kwsTestActive) return;
  kwsTestActive = false;
  Serial.printf("MARVIN_EVENT {\"type\":\"kws_test\",\"state\":\"%s\",\"duration_ms\":10000}\n", result);
}

static void processSerialCommands() {
  while (Serial.available()) {
    const char value = static_cast<char>(Serial.read());
    if (value == '\r') continue;
    if (value != '\n' && serialCommandLength + 1 < sizeof(serialCommand)) {
      serialCommand[serialCommandLength++] = value;
      continue;
    }
    serialCommand[serialCommandLength] = '\0';
    if (strncmp(serialCommand, "SERVER ", 7) == 0) {
      const char* value = serialCommand + 7;
      const char* space = strchr(value, ' ');
      const uint16_t port = space ? static_cast<uint16_t>(atoi(space + 1)) : 8000;
      const size_t hostLength = space ? std::min<size_t>(space - value, sizeof(asrHost) - 1)
                                      : std::min(strlen(value), sizeof(asrHost) - 1);
      memcpy(asrHost, value, hostLength); asrHost[hostLength] = '\0';
      audioWs.begin(asrHost, port, "/ws/esp32");
      audioWs.setReconnectInterval(2000);
      audioWsConfigured = true;
      Serial.printf("ASR_STREAM configured host=%s port=%u\n", asrHost, unsigned(port));
    } else if (strcmp(serialCommand, "KWS_TEST_START") == 0) {
      kwsTestActive = true;
      kwsTestDeadlineMs = millis() + 10000;
      Serial.println("MARVIN_EVENT {\"type\":\"kws_test\",\"state\":\"armed\",\"duration_ms\":10000,\"source\":\"INMP441\"}");
    } else if (strcmp(serialCommand, "KWS_TEST_STOP") == 0) {
      stopKwsTest("stopped");
    }
    serialCommandLength = 0;
  }
}

static const char* resetName(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_EXT: return "EXT";
    case ESP_RST_SW: return "SW";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_INT_WDT: return "INT_WDT";
    case ESP_RST_TASK_WDT: return "TASK_WDT";
    case ESP_RST_WDT: return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_SDIO: return "SDIO";
    default: return "UNKNOWN";
  }
}

void setup() {
  Serial.begin(115200);
  Serial.printf("RESET reason=%s\n", resetName(esp_reset_reason()));
  delay(1000);
  Wire.begin(21, 22);
  Wire.setClock(400000);
  Wire.beginTransmission(0x3C);
  oledPresent = Wire.endTransmission() == 0;
  if (oledPresent) {
    oled.setI2CAddress(0x3C << 1);
    oled.begin();
    oledIdle();
    Serial.println("OLED_READY controller=SH1106 address=0x3C sda=21 scl=22");
  } else {
    Serial.println("OLED_OFFLINE address=0x3C");
  }
  heapBeforeInit = heap_caps_get_free_size(kHeapCaps);
  Serial.printf("BOOT model=%s sample_rate=%d channel=RIGHT hop_ms=%u\n", baseline::kModelVersion,
      marvin::kSampleRate, unsigned(marvin::kHopSamples * 1000 / marvin::kSampleRate));
  if (g_marvin_cascade_s1_len != baseline::kStage1ModelBytes ||
      g_marvin_cascade_s2_len != baseline::kStage2ModelBytes) fatal("Model byte count mismatch");
  const tflite::Model* model1 = tflite::GetModel(g_marvin_cascade_s1);
  const tflite::Model* model2 = tflite::GetModel(g_marvin_cascade_s2);
  if (model1->version() != TFLITE_SCHEMA_VERSION || model2->version() != TFLITE_SCHEMA_VERSION)
    fatal("TFLite schema mismatch");
  // Resolver sets match the inspected flatbuffers (S1: 7 ops, S2: 8 ops incl. MAX_POOL_2D).
  static tflite::MicroMutableOpResolver<7> resolver1;
  if (resolver1.AddExpandDims() != kTfLiteOk || resolver1.AddConv2D() != kTfLiteOk ||
      resolver1.AddReshape() != kTfLiteOk || resolver1.AddDepthwiseConv2D() != kTfLiteOk ||
      resolver1.AddMean() != kTfLiteOk || resolver1.AddFullyConnected() != kTfLiteOk ||
      resolver1.AddLogistic() != kTfLiteOk) fatal("Stage-1 operator registration failed");
  static tflite::MicroMutableOpResolver<8> resolver2;
  if (resolver2.AddConv2D() != kTfLiteOk || resolver2.AddDepthwiseConv2D() != kTfLiteOk ||
      resolver2.AddExpandDims() != kTfLiteOk || resolver2.AddFullyConnected() != kTfLiteOk ||
      resolver2.AddLogistic() != kTfLiteOk || resolver2.AddMaxPool2D() != kTfLiteOk ||
      resolver2.AddMean() != kTfLiteOk || resolver2.AddReshape() != kTfLiteOk)
    fatal("Stage-2 operator registration failed");
  static tflite::MicroInterpreter interpreter1(model1, resolver1, stage1Arena, kStage1ArenaBytes);
  static tflite::MicroInterpreter interpreter2(model2, resolver2, stage2Arena, kStage2ArenaBytes);
  stage1Interpreter = &interpreter1; stage2Interpreter = &interpreter2;
  if (stage1Interpreter->AllocateTensors() != kTfLiteOk) fatal("Stage 1 tensor allocation failed");
  if (stage2Interpreter->AllocateTensors() != kTfLiteOk) fatal("Stage 2 tensor allocation failed");
  if (stage1Interpreter->outputs_size() != 2) fatal("Stage-1 dual output missing");
  stage1Input = stage1Interpreter->input(0); stage1Output = stage1Interpreter->output(0);
  stage1Feature = stage1Interpreter->output(1);
  stage2Input = stage2Interpreter->input(0); stage2Output = stage2Interpreter->output(0);
  validateStage1(stage1Input, stage1Output);
  validateHandoff(stage1Feature, stage2Input);
  if (stage2Output->type != kTfLiteInt8 || stage2Output->bytes != 1 ||
      fabsf(stage2Output->params.scale - baseline::kOutScale) > 1e-9f ||
      stage2Output->params.zero_point != baseline::kOutZero)
    fatal("Stage-2 output mismatch");
  for (int i = 0; i < 2; ++i) {
    audio[i] = static_cast<int16_t*>(heap_caps_malloc(marvin::kSamples * sizeof(int16_t), kHeapCaps));
    if (!audio[i]) fatal("Audio window allocation failed");
  }
  frontend.begin();
  pcmQueue = xQueueCreateStatic(8, sizeof(PcmChunk), pcmQueueStorage, &pcmQueueState);
  previewQueue = xQueueCreateStatic(1, sizeof(PreviewChunk), previewQueueStorage, &previewQueueState);
  freeQueue = xQueueCreateStatic(1, sizeof(int), freeQueueStorage, &freeQueueState);
  readyQueue = xQueueCreateStatic(1, sizeof(AudioWindow), readyQueueStorage, &readyQueueState);
  int freeIndex = 1;
  xQueueSend(freeQueue, &freeIndex, 0);
  setupI2S();
  WiFi.mode(WIFI_STA);
  WiFi.begin(MARVIN_WIFI_SSID, MARVIN_WIFI_PASSWORD);
  audioWs.onEvent(audioWsEvent);
  TaskHandle_t capture = xTaskCreateStaticPinnedToCore(captureTask, "mic_capture", sizeof(captureStack),
      nullptr, 2, captureStack, &captureTaskState, 0);
  if (!capture) fatal("Capture task creation failed");
  TaskHandle_t preview = xTaskCreateStaticPinnedToCore(previewTask, "mic_preview", sizeof(previewStack),
      nullptr, 1, previewStack, &previewTaskState, 0);
  if (!preview) fatal("Preview task creation failed");
  Serial.printf("MODEL_READY model=%s stage1_bytes=%u stage2_bytes=%u stage1_arena_reserved=%u stage1_arena_used=%u "
                "stage2_arena_reserved=%u stage2_arena_used=%u\n", baseline::kModelVersion,
      unsigned(g_marvin_cascade_s1_len), unsigned(g_marvin_cascade_s2_len),
      unsigned(kStage1ArenaBytes), unsigned(stage1Interpreter->arena_used_bytes()),
      unsigned(kStage2ArenaBytes), unsigned(stage2Interpreter->arena_used_bytes()));
  Serial.printf("RAM_INIT heap_before=%u heap_after=%u min_heap=%u static_ram=%u\n",
      unsigned(heapBeforeInit), unsigned(heap_caps_get_free_size(kHeapCaps)),
      unsigned(heap_caps_get_minimum_free_size(kHeapCaps)), unsigned(staticRamBytes()));
  // Application baseline after model, audio, queues, I2S and task initialization.
  heapBaseline = heap_caps_get_free_size(kHeapCaps);
  Serial.println("MIC_READY channel=RIGHT bclk=14 ws=15 dout=32 sample_bits=24 slot_bits=32");
  statsStartMs = millis();
}

void loop() {
  static uint32_t lastHeartbeatMs;
  const uint32_t now = millis();
  processSerialCommands();
  if (audioWsConfigured) audioWs.loop();
  if (listeningPending && static_cast<int32_t>(now - listeningAtMs) >= 0) {
    listeningPending = false;
    oledShowListening();
  }
  if (transcriptUntilMs && static_cast<int32_t>(now - transcriptUntilMs) >= 0) {
    transcriptUntilMs = 0;
    oledIdle();
  }
  if (asrSessionActive && now - asrSessionStartMs > 30000) {
    Serial.println("ASR_TIMEOUT");
    asrSamplesRemaining = 0;
    asrCaptureDone = false;
    asrSessionActive = false;
    listeningPending = false;
    xQueueReset(pcmQueue);
    oledIdle();
  }
  PcmChunk pcmChunk;
  while (audioWsConfigured && audioWs.isConnected() && xQueueReceive(pcmQueue, &pcmChunk, 0) == pdTRUE)
    if (!sendAdpcm(pcmChunk.pcm, pcmChunk.samples)) asrDroppedChunks += (pcmChunk.samples + 255) / 256;
  if (asrCaptureDone && !asrSamplesRemaining && uxQueueMessagesWaiting(pcmQueue) == 0) {
    asrCaptureDone = false;
    if (audioWsConfigured && audioWs.isConnected() &&
        audioWs.sendTXT("{\"type\":\"audio_end\",\"duration_ms\":4000}"))
      Serial.printf("ASR_AUDIO_SENT bytes=%u wire_bytes=%u dropped_chunks=%u\n", unsigned(asrAudioBytesSent), unsigned(asrWireBytesSent), unsigned(asrDroppedChunks));
    else Serial.printf("ASR_AUDIO_FAILED bytes=%u wire_bytes=%u dropped_chunks=%u\n", unsigned(asrAudioBytesSent), unsigned(asrWireBytesSent), unsigned(asrDroppedChunks));
  }
  if (kwsTestActive && static_cast<int32_t>(now - kwsTestDeadlineMs) >= 0)
    stopKwsTest("no_wake");
  if (now - lastHeartbeatMs >= 1000) {
    lastHeartbeatMs = now;
    const IPAddress ip = WiFi.localIP();
    const uint32_t remaining = kwsTestActive && static_cast<int32_t>(kwsTestDeadlineMs - now) > 0
        ? kwsTestDeadlineMs - now : 0;
    Serial.printf("MARVIN_HEARTBEAT {\"type\":\"heartbeat\",\"device\":\"esp32\",\"model\":\"%s\",\"uptime_ms\":%u,"
                  "\"wifi_ip\":\"%u.%u.%u.%u\",\"wifi_rssi\":%d,\"kws_test_active\":%s,\"kws_test_remaining_ms\":%u}\n",
                  baseline::kModelVersion, unsigned(now), ip[0], ip[1], ip[2], ip[3], WiFi.RSSI(),
                  kwsTestActive ? "true" : "false", unsigned(remaining));
  }
  AudioWindow window;
  if (xQueueReceive(readyQueue, &window, pdMS_TO_TICKS(20)) != pdTRUE) return;
  const int64_t featureStart = esp_timer_get_time();
  frontend.computeRolling(audio[window.index], stage1Input->data.int8,
                          stage1Input->params.scale, stage1Input->params.zero_point);
  const int64_t featureEnd = esp_timer_get_time();
  const int64_t stage1Start = esp_timer_get_time();
  if (stage1Interpreter->Invoke() != kTfLiteOk) fatal("Stage 1 invoke failed");
  const int64_t stage1End = esp_timer_get_time();
  ++stage1Runs;
  const float score1 = probability(stage1Output);
  float score2 = 0.0f;
  int64_t stage2Us = 0, copyUs = 0;
  bool invoked2 = false, wake = false;
  Serial.printf("KWS S1=%.4f S1_us=%lld candidate=%d\n", score1, (long long)(stage1End - stage1Start), score1 >= baseline::kStage1Threshold ? 1 : 0);
  if (score1 >= baseline::kStage1Threshold) {
    invoked2 = true;
    ++stage2Runs;
    // Single 1200-byte int8 memcpy; quantizations are identical, no conversion.
    const int64_t copyStart = esp_timer_get_time();
    memcpy(stage2Input->data.int8, stage1Feature->data.int8, baseline::kFeatBytes);
    copyUs = esp_timer_get_time() - copyStart;
    const int64_t stage2Start = esp_timer_get_time();
    if (stage2Interpreter->Invoke() != kTfLiteOk) fatal("Stage 2 invoke failed");
    stage2Us = esp_timer_get_time() - stage2Start;
    score2 = probability(stage2Output);
    Serial.printf("KWS S2=%.4f copy_us=%lld S2_us=%lld\n", score2, (long long)copyUs, (long long)stage2Us);
    if (score2 >= baseline::kStage2Threshold) {
      Serial.printf("FINAL=MARVIN total_candidate_us=%lld\n", (long long)(copyUs + stage2Us));
      if (lastWakeMs == 0 || now - lastWakeMs >= marvin::kCooldownMs) {
        wake = true; lastWakeMs = now; ++wakeCount;
        Serial.printf("MARVIN_EVENT {\"type\":\"wake\",\"model\":\"%s\",\"s1\":%.4f,\"s2\":%.4f,\"wake_count\":%u}\n",
                      baseline::kModelVersion, score1, score2, unsigned(wakeCount));
        Serial.println("MARVIN DETECTED");
        // Arm capture before any display or network write can consume time.
        bool startedAsr = false;
        if (!asrSessionActive && audioWsConfigured && audioWs.isConnected()) {
          xQueueReset(pcmQueue);
          asrDroppedChunks = 0;
          asrAudioBytesSent = 0;
          asrWireBytesSent = 0;
          asrCaptureDone = false;
          asrSamplesRemaining = kFollowingSpeechSamples;
          asrSessionActive = true;
          asrSessionStartMs = millis();
          startedAsr = true;
        }
        if (startedAsr) oledListening();
        // Only a confirmed two-stage wake starts ASR. Arm following speech
        // before transmitting the one-second rolling pre-roll.
        if (startedAsr) {
          audioWs.sendTXT("{\"type\":\"wake\",\"encoding\":\"ima_adpcm4\"}");
          for (uint16_t offset = 0; offset < marvin::kSamples; offset += kPcmChunkSamples) {
            const uint16_t count = std::min<uint16_t>(kPcmChunkSamples, marvin::kSamples - offset);
            if (!sendAdpcm(audio[window.index] + offset, count))
              asrDroppedChunks += (count + 255) / 256;
          }
          audioWs.sendTXT("{\"type\":\"state\",\"state\":\"STREAMING_AUDIO\"}");
        } else {
          Serial.println("ASR_STREAM unavailable");
        }
        if (kwsTestActive) stopKwsTest("detected");
      }
    } else {
      Serial.printf("FINAL=reject total_candidate_us=%lld\n", (long long)(copyUs + stage2Us));
    }
  }
  // The confirmed-wake path may transmit this window as ASR pre-roll, so the
  // capture task cannot reuse it until cascade processing is complete.
  xQueueSend(freeQueue, &window.index, portMAX_DELAY);
  const int64_t featureUs = featureEnd - featureStart;
  const int64_t stage1Us = stage1End - stage1Start;
  const float denominatorUs = marvin::kHopSamples * 1000000.0f / marvin::kSampleRate;
  const float frontendDuty = 100.0f * featureUs / denominatorUs;
  const float stage1Duty = 100.0f * stage1Us / denominatorUs;
  const float stage2Duty = 100.0f * stage2Us / denominatorUs;
  const float invocationPercent = 100.0f * stage2Runs / stage1Runs;
  Serial.printf("MARVIN_METRIC {\"type\":\"kws\",\"model\":\"%s\",\"s1\":%.4f,\"s2\":%.4f,"
                "\"wake\":%s,\"stage2_invoked\":%s,\"s1_ms\":%.3f,\"s2_ms\":%.3f,\"feature_ms\":%.3f,"
                "\"frontend_us\":%lld,\"stage1_us\":%lld,\"feature_copy_us\":%lld,\"stage2_us\":%lld,"
                "\"copy_us\":%lld,\"candidate_ms\":%.3f,\"total_candidate_us\":%lld,\"free_heap\":%u,\"min_free_heap\":%u,\"heap_baseline\":%u,\"s1_runs\":%u,\"s2_runs\":%u,"
                "\"stage2_invocation_percent\":%.3f,\"wake_count\":%u,\"frontend_duty_percent\":%.3f,"
                "\"s1_duty_percent\":%.3f,\"s2_duty_percent\":%.3f,\"total_duty_percent\":%.3f,"
                "\"hop_ms\":%u,\"peak\":%.6f,\"right_rms\":%.6f,\"left_rms\":%.6f,"
                "\"dma_overflows\":%u,\"skipped_windows\":%u,\"kws_test_active\":%s,\"kws_test_remaining_ms\":%u}\n",
      baseline::kModelVersion, score1, score2, wake ? "true" : "false", invoked2 ? "true" : "false",
      stage1Us / 1000.0, stage2Us / 1000.0, featureUs / 1000.0,
      (long long)featureUs, (long long)stage1Us, (long long)copyUs, (long long)stage2Us, (long long)copyUs,
      (featureUs + stage1Us + copyUs + stage2Us) / 1000.0,
      (long long)(featureUs + stage1Us + copyUs + stage2Us), unsigned(heap_caps_get_free_size(kHeapCaps)),
      unsigned(heap_caps_get_minimum_free_size(kHeapCaps)), unsigned(heapBaseline), unsigned(stage1Runs), unsigned(stage2Runs),
      invocationPercent, unsigned(wakeCount), frontendDuty, stage1Duty, stage2Duty,
      frontendDuty + stage1Duty + stage2Duty,
      unsigned(marvin::kHopSamples * 1000 / marvin::kSampleRate), window.peak, window.rightRms, window.leftRms,
      unsigned(window.dmaOverflows), unsigned(window.skippedWindows), kwsTestActive ? "true" : "false",
      unsigned(kwsTestActive && static_cast<int32_t>(kwsTestDeadlineMs - now) > 0 ? kwsTestDeadlineMs - now : 0));
  totalFeUs += featureUs; totalS1Us += stage1Us; totalS2Us += stage2Us;
  if (now - statsStartMs >= 10000) {
    const float elapsedUs = (now - statsStartMs) * 1000.0f;
    Serial.printf("KWS_STATS s1_runs=%u s2_runs=%u s2_pct=%.3f s1_avg_us=%.0f s2_avg_us=%.0f "
                  "fe_avg_us=%.0f duty_pct=%.3f free_heap=%u\n",
        unsigned(stage1Runs - statsS1Runs), unsigned(stage2Runs - statsS2Runs),
        stage1Runs == statsS1Runs ? 0.0f : 100.0f * (stage2Runs - statsS2Runs) / (stage1Runs - statsS1Runs),
        stage1Runs == statsS1Runs ? 0.0f : float(totalS1Us - statsS1Us) / (stage1Runs - statsS1Runs),
        stage2Runs == statsS2Runs ? 0.0f : float(totalS2Us - statsS2Us) / (stage2Runs - statsS2Runs),
        stage1Runs == statsS1Runs ? 0.0f : float(totalFeUs - statsFeUs) / (stage1Runs - statsS1Runs),
        100.0f * (totalFeUs - statsFeUs + totalS1Us - statsS1Us + totalS2Us - statsS2Us) / elapsedUs,
        unsigned(heap_caps_get_free_size(kHeapCaps)));
    statsStartMs = now; statsS1Runs = stage1Runs; statsS2Runs = stage2Runs;
    statsFeUs = totalFeUs; statsS1Us = totalS1Us; statsS2Us = totalS2Us;
  }
}
