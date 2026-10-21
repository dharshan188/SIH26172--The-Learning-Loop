# Validation record

## Model

The model bytes copied from `~/Downloads/marvin_model_data.h` are unchanged.
Only `const`, 16-byte alignment, a comment and `#pragma once` were added.

- Bytes: 17,256
- SHA-256: `6fab0703b6870e378c1150cba25079852eace26d0633504b87db01e87f150713`
- Input: INT8 `[1,98,24]`, scale `0.007843137718737125`, zero point `-1`
- Output: INT8 `[1,1]`, scale `0.00390625`, zero point `-128`
- Seven operator registrations match the actual FlatBuffer operator table.

## Numerical frontend test

`tools/check_frontend.py` compiles the actual `frontend.cpp` with host g++ and compares it to TensorFlow 2.21.0, using the confirmed training operations. No substitute frontend is tested.

| Input | Maximum normalized-feature absolute error | INT8 differences / 2352 | Largest INT8 difference |
|---|---:|---:|---:|
| Silence | 0 | 0 | 0 |
| Constant DC | 0 | 0 | 0 |
| 440 Hz tone | 0.000003219 | 0 | 0 |
| 1000 Hz tone | 0.000027538 | 2 | 1 |
| Noise | 0.000001252 | 0 | 0 |
| Quiet noise | 0.000000477 | 0 | 0 |
| Full-scale noise | 0.000001431 | 0 | 0 |
| Impulse | 0.000000954 | 0 | 0 |

All test cases passed (`max float error < 0.0002`, `max INT8 error <= 1`). This is mathematical/numerical parity within tolerance, not bitwise equality across different FFT and math-library implementations. The test was run on the host; Xtensa libm and compiler results can differ slightly. Actual captured audio and a validation dataset remain the best end-to-end accuracy test.

## ESP32 compile/link check

**Passed** for `esp32:esp32:esp32doit-devkit-v1`:

- Arduino core 3.2.0, official SDK `idf-release_v5.4-2f7dcd86-v1`.
- Official core and SDK archives verified against their board-index SHA-256 checksums.
- Matching compiler `xtensa-esp-elf-g++ 14.2.0`, release `esp-14.2.0_20241119`.
- Chirale_TensorFLowLite 2.0.0; native 64-bit Arduino CLI 1.3.0.
- Flash/program storage: **441,922 bytes** (33% of default app partition).
- Static `.data + .bss`: **70,508 bytes**. Audio buffers add 128,000 bytes at startup, plus I2S DMA/driver/system heap allocations. The compile report is not the runtime RAM total.
- ELF confirms the 17,256-byte model in flash-mapped data at `0x3f40d3f0`, not DRAM.

The build used an isolated temporary Arduino data directory and explicit paths to the matching toolchain/SDK after the installed 32-bit Snap CLI's package download failed. No core or library source patches were needed. The sketch uses ESP-IDF critical sections for its ISR counter because this compiler configuration does not guarantee lock-free C++ atomics.

## Hardware measurements

No upload or on-board inference run was performed. Arena use, microphone alignment, inference latency, sustained 1 Hz operation, detection accuracy, and runtime RAM are reported by the firmware and must be measured on the device. The 32 KiB arena is an initial reservation, not a measured minimum.
