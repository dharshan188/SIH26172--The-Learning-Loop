# MARVIN on ESP32-WROOM-32

Complete Arduino sketch for the supplied 17,256-byte INT8 model, Arduino IDE 2.3.6, and Espressif Arduino core **3.2.0**. Open `MarvinWakeWord/MarvinWakeWord.ino`. See [VALIDATION.md](VALIDATION.md) for verification results. The existing PlatformIO project is separate; its pinned platform does not select Arduino core 3.2.0.

## Files

```text
sih/
├── arduino/
│   ├── README.md
│   ├── VALIDATION.md
│   └── MarvinWakeWord/
│       ├── MarvinWakeWord.ino      # I2S, buffering, TFLM, timing and RAM reports
│       ├── frontend.h
│       ├── frontend.cpp            # Complete float32 frontend and radix-2 FFT
│       └── marvin_model_data.h     # Supplied bytes; aligned const array in flash
└── tools/
    ├── inspect_model.py            # Optional model/operator inspection
    └── check_frontend.py           # Optional C++ versus TensorFlow parity test
```

## Install and build

Arduino IDE:

1. Add `https://espressif.github.io/arduino-esp32/package_esp32_index.json` to **File → Preferences → Additional boards manager URLs**.
2. In Boards Manager install **esp32 by Espressif Systems, version 3.2.0**.
3. In Library Manager install **Chirale_TensorFLowLite by Chirale, TensorFlow Authors, version 2.0.0**. This provides TFLite Micro directly; ArduTFLite, ArduinoFFT, and additional DSP libraries are unnecessary.
4. Open the `.ino` above. Select **DOIT ESP32 DEVKIT V1**, CPU **240 MHz**, upload **115200**, the connected serial port, and the default partition scheme. PSRAM is not required.
5. Verify, then Upload. If connection stalls, hold BOOT until upload connects, then release it. Close other serial monitors first.

Equivalent Linux CLI commands (run from `/home/dharshan/sih`):

```bash
arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli config set network.connection_timeout 3600s
arduino-cli core update-index
arduino-cli core install esp32:esp32@3.2.0
arduino-cli lib update-index
arduino-cli lib install 'Chirale_TensorFLowLite@2.0.0'
arduino-cli compile --fqbn esp32:esp32:esp32doit-devkit-v1 --build-path /tmp/marvin-build arduino/MarvinWakeWord
arduino-cli board list
# Replace /dev/ttyUSB0 with the port shown for your board.
arduino-cli upload --fqbn esp32:esp32:esp32doit-devkit-v1 --port /dev/ttyUSB0 --input-dir /tmp/marvin-build
arduino-cli monitor --port /dev/ttyUSB0 --config baudrate=115200
```

Use a native 64-bit Arduino CLI on a 64-bit Linux host: some Snap distributions ship a 32-bit CLI, which selects the wrong tool downloads. On this machine `/snap/bin/arduino-cli` is 32-bit. For a native CLI, run the following **before** the CLI commands above:

```bash
mkdir -p /tmp/marvin-cli-install "$HOME/.local/bin"
curl -fL --retry 3 https://downloads.arduino.cc/arduino-cli/arduino-cli_1.3.0_Linux_64bit.tar.gz -o /tmp/marvin-cli-install/cli.tar.gz
tar -xzf /tmp/marvin-cli-install/cli.tar.gz -C /tmp/marvin-cli-install arduino-cli
install -m 755 /tmp/marvin-cli-install/arduino-cli "$HOME/.local/bin/arduino-cli"
export PATH="$HOME/.local/bin:$PATH"
hash -r
arduino-cli version
```

 CLI and IDE installations can also use different data/sketchbook directories; install the core and library in the environment doing the build.

## Wiring and capture

| INMP441 | ESP32 |
|---|---|
| VCC | 3.3 V |
| GND | GND |
| SCK/BCLK | GPIO14 |
| WS/LRCLK | GPIO15 |
| SD/DOUT | GPIO32 |
| L/R | High / 3.3 V for RIGHT (retain your working right-channel configuration) |

The new ESP-IDF `driver/i2s_std.h` API is used, compatible with the IDF 5.4 base of Arduino core 3.2.0. Do not add the legacy `driver/i2s.h` API to this sketch. Philips I2S uses 32-bit left and right slots at 16 kHz (1.024 MHz BCLK). Stereo DMA captures both slots, and only the right slot enters the mono audio buffer. Signed 24-bit samples are extracted from bits 31:8 and divided by 8388608; there is no gain, AGC, or 16-bit truncation.

A capture task on core 0 fills two alternating float32 buffers while the Arduino loop on core 1 preprocesses and infers. Each window contains exactly **16000 samples**, after a 100 ms startup discard. There is no `delay(1000)` between windows. Results settle to approximately 1 Hz if preprocessing, inference, and reporting keep up. The physical I2S clock and scheduler introduce ordinary timing tolerances; 16000 samples defines one second, not a wall-clock timer stopping a read.

If buffers are unavailable, a complete window is drained and counted as skipped. DMA overflows are counted, and affected windows are discarded instead of passed to the model. Neither case is a valid sustained 1 Hz run. Nonoverlapping windows follow your request; a word straddling a window boundary can be missed.

## Preprocessing

The implementation preserves the confirmed training conventions:

1. Float32 mono audio in [-1,1]; remove the mean of all 16000 samples.
2. Pre-emphasize with 0.97; retain the first centered sample.
3. 400-sample **periodic** Hann, hop 160, zero-pad each frame to 512. No centering or end padding: `1 + floor((16000 - 400)/160) = 98` frames.
4. Unnormalized forward FFT; `re² + im²` for bins 0–256. No FFT-length division, window-energy correction, or doubling of one-sided bins.
5. TensorFlow/HTK Mel triangles with edges equally spaced in Mel, 24 bands, 80–7600 Hz. Slopes are linear **in Mel**, not Hz; no Slaney area normalization. DC weight is zero.
6. Natural logarithm `log(mel + 1e-6)`, clip to [-12,4], normalize `(logmel + 4)/8`.
7. Frame-major `[98,24]` written directly into `[1,98,24]` input: ties-to-even `round(feature / 0.007843137718737125 - 1)`, clamp [-128,127].

This implements the same mathematical preprocessing, not a cheaper approximation. Different FFT, reduction, and libm implementations can produce small float differences, including an occasional 1-LSB INT8 difference near a rounding boundary. Bit-for-bit TensorFlow identity on Xtensa is not promised. The mean uses eight float32 partial sums to limit accumulation drift; all frontend arithmetic remains float32. The host parity test measures those differences rather than assuming equality.

## Model and threshold

Only these seven kernels are registered; the graph's actual operator versions are shown:

| Operator | Version |
|---|---:|
| EXPAND_DIMS | 1 |
| CONV_2D | 3 |
| RESHAPE | 1 |
| DEPTHWISE_CONV_2D | 3 |
| MEAN | 2 |
| FULLY_CONNECTED | 4 |
| LOGISTIC | 2 |

The input/output shapes, types, quantization parameters, model length, and schema are checked at startup. The model header has `alignas(16) const unsigned char ...`; both model data and its length are const. The source in Downloads is untouched.

Probability is `(raw_int8 + 128) * 0.00390625`, using the output tensor's actual scale/zero point. Detection uses `probability >= 0.365`:

- -35 → 0.36328125 → **not detected**.
- -34 → 0.36718750 → **detected**.

There is no extra sigmoid, smoothing, gain, or threshold adjustment.

## RAM and CPU

The initial tensor arena is **32 KiB**, static and 16-byte aligned. Allocation failure prints the size and stops clearly. An arena allocation failure can mean insufficient space or another TFLM preparation problem: inspect its diagnostics. If space is exhausted, increase `kArenaBytes` in 8 KiB increments and rebuild. After a successful run, `arena_used` gives the actual requirement for this library/model combination; retain a margin when reducing the reservation.

Major reserved buffers:

| Resource | Bytes |
|---|---:|
| Two 16000-sample float32 audio windows | 128,000 |
| Tensor arena | 32,768 |
| Frontend workspace (window, twiddles, FFT, sparse Mel weights) | 10,314, rounded to 10,316 for alignment |
| Capture task stack | 4,096 |
| I2S DMA (4 × 256 stereo frames × 8 bytes) | 8,192 |

These dominate at about **179 KiB** before queues, interpreter metadata, drivers, Arduino/FreeRTOS globals, and other task stacks. This favors the <256 KiB target; ~180 KiB **total firmware runtime RAM** cannot be guaranteed with continuous full-precision double buffering. Actual totals and timings must be read on the board. No PSRAM, network stacks, full float spectrogram, dense 257×24 Mel matrix, or per-cycle heap allocation is used. The two 64,000-byte audio buffers are allocated once in internal RAM during setup; this avoids the original ESP32 static DRAM limit while preserving full precision. Allocation failures print free heap and the largest block. Startup driver allocation is also necessary for I2S.

Printed memory values use internal, byte-addressable heap capabilities consistently:

- Free heap immediately before and after `AllocateTensors`. The arena is static, so these values may be almost identical; this does not imply the arena used no RAM.
- Reserved arena and `arena_used_bytes()`.
- Current free heap, minimum free heap since boot, largest free block.
- Static `.data + .bss`, allocated heap, and their sum as **approximate runtime RAM**. This includes static arena/frontend/task storage plus dynamically allocated audio/driver/system/task storage without counting the static arena twice. It excludes IRAM code, reserved regions, ROM, and flash; it is not a complete physical-SRAM utilization figure.
- Setup heap delta is additional heap use since `setup()`, not total application RAM.

CPU hotspots are 98 × 512-point FFTs, 2352 logarithms, and reference INT8 convolutions. Sparse Mel weights and precomputed Hann/twiddles avoid repeated trigonometry or a dense matrix. The portable FFT is exact in algorithm; no reduced-resolution frontend is used.

Inference duty = `inference_us / 1,000,000 × 100`. A second metric reports preprocessing + inference duty. These are wall-time fractions of a one-second interval, **not** measured whole-chip CPU utilization; capture, printing, scheduling, and two-core operation are separate.

`total_cycle_capture_to_result` spans read-start to inference completion and excludes printing. Capture overlaps the previous window's processing, so this latency is typically >1000 ms even when results arrive every 1000 ms. `result_interval` measures throughput between inference completions. `capture_wall` can vary by a DMA block because I2S reads return buffered samples. A processing time ≥1000 ms prints an overrun warning.

## Serial-monitor test

1. Open the monitor at **115200 baud** and press EN/reset. Confirm successful allocation, tensor checks, CPU 240 MHz, and startup RAM values.
2. Confirm approximately one result per second after the first window. `skipped_windows` and `DMA_overflows` must stay zero. Record `minimum_free_heap` and approximate RAM after several minutes.
3. Stay quiet, speak unrelated words, then speak MARVIN repeatedly with pauses. Each result includes raw INT8, probability, detected/not detected, preprocessing time, inference µs/ms, capture-to-result cycle time, result interval, both duty estimates, and RAM metrics.
4. `Audio: peak` should respond to voice. Constant zero suggests wrong slot/wiring/L/R selection. Repeated values near 1 suggest clipping or an alignment problem. Microphone level/acoustics can differ from training despite matching preprocessing; do not silently alter gain or normalization.
5. Verify the -35/-34 decision boundary above. Silence need not produce any predetermined model probability.
6. If timing overruns or dropped windows occur, retain the prints as evidence; 1 Hz is a measured requirement, not a guaranteed performance claim. An optimized FFT/kernel implementation is a possible next optimization only after numerical parity checks.

Host verification (optional; these packages are not Arduino dependencies):

```bash
python3 -m venv /tmp/marvin-verify
/tmp/marvin-verify/bin/pip install tensorflow-cpu numpy tflite
/tmp/marvin-verify/bin/python tools/inspect_model.py
/tmp/marvin-verify/bin/python tools/check_frontend.py
```

## References

- [Arduino core 3.2.0 I2S implementation](https://github.com/espressif/arduino-esp32/blob/3.2.0/libraries/ESP_I2S/src/ESP_I2S.cpp) and [ESP-IDF 5.4 standard I2S driver](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32/api-reference/peripherals/i2s.html).
- [Chirale TensorFlow Lite Micro library](https://github.com/spaziochirale/Chirale_TensorFlowLite). The maintainer does not guarantee every ESP32 board; build and hardware validation are distinct.
- [TensorFlow STFT](https://www.tensorflow.org/api_docs/python/tf/signal/stft), [periodic Hann](https://www.tensorflow.org/api_docs/python/tf/signal/hann_window), and [Mel filter implementation](https://github.com/tensorflow/tensorflow/blob/v2.16.1/tensorflow/python/ops/signal/mel_ops.py).
