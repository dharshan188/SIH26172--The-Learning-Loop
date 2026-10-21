# MARVIN: Listen Locally, Connect When Needed

**SIH 2026 · Problem Statement ID: SIH26172 · Team: The Learning Loop (Team ID 158994)**

> *A voice assistant that sleeps in silence, wakes only for its name, and speaks to the cloud only after it has proven it was called.*

---

## 1. The One-Line Pitch

MARVIN is a **privacy-first, ultra-low-power, two-stage wake-word system that runs entirely on a ₹400-class ESP32 microcontroller**. It detects its name on-device in about 50 ms using a 17 KB INT8 neural network. It then double-checks with an independent verifier, and **only after verification** does it stream audio onward for speech recognition. Until that moment, no audio ever leaves the device.

---

## 2. The Problem: Today's Voice Assistants Are Always Listening and Always Leaking

Voice is the most natural interface for a billion Indians, including first-time smartphone users, the elderly, farmers, shopkeepers, and people who cannot read or type comfortably. But the way voice assistants are built today creates four serious problems.

| Pain point | What happens today | Real-world cost |
|---|---|---|
| **Privacy** | Many devices stream or buffer ambient audio to the cloud to catch one wake word. | Private conversations are exposed to breaches, mis-triggers, and misuse. |
| **Power** | Continuous streaming keeps the radio and a heavy processor awake. | Battery devices die in hours instead of months. |
| **Latency** | The wake decision depends on network round trips. | Laggy response, and no function at all without internet. |
| **False triggers** | Look-alike words ("Margin", "Marine", "Martin", "Nine") wake simple detectors. | Annoying activations, wasted bandwidth, and a loss of user trust. |

India adds further constraints: patchy connectivity in rural areas, price-sensitive buyers, and a growing need for **Atmanirbhar (self-reliant) electronics** that do not depend on foreign cloud APIs for the basic act of being heard.

**The core insight:** the wake-word decision is a tiny problem that has been given a huge, leaky solution. It belongs on the edge.

---

## 3. Our Solution: Edge-First, Cascade-Verified, Cloud-Last

MARVIN inverts the usual architecture:

```
 Microphone ──► Log-Mel features ──► Stage-1 CNN ──► Stage-2 Verifier ──► Cloud ASR ──► Action
 (INMP441,      (98 × 24, on-chip)   "candidate?"     "really MARVIN?"     (only now)    (OLED +
  16 kHz)                             score > 0.60     score > 0.65                       dashboard)
        ▲────────────── everything left of "Cloud ASR" runs on the ESP32 ──────────────▲
```

### How it works, step by step

1. **Voice input.** The user says *"Hey MARVIN, what is the weather?"*
2. **Audio capture.** An INMP441 digital I²S microphone records 16 kHz mono audio into a rolling buffer on the ESP32. No audio is stored or transmitted at this point.
3. **On-chip preprocessing.** A complete float32 DSP frontend (windowing, radix-2 FFT, mel filterbank, log compression) turns audio into a **98 × 24 Log-Mel spectrogram**. We verified that the C++ frontend matches the TensorFlow reference.
4. **Stage-1 CNN (the Sentinel).** A small INT8 convolutional network scores a window every 500 ms. A candidate must clear a three-window gate, which filters out one-off noise spikes.
5. **Stage-2 verifier (the Judge).** An *independent* second model re-examines only the candidates that Stage-1 flagged. It is trained to reject near-miss words. Only its acceptance confirms the wake word.
6. **Wake confirmed → listening state.** The device enters an explicit `LISTENING` state shown on the OLED, so users always know when the device is active.
7. **Post-wake streaming.** Only now does the ESP32 send 20 ms PCM16 frames over a binary WebSocket. Streaming ends after 1.2 s of silence, or after a 9 s hard cap.
8. **Speech recognition.** The audio is transcribed by `faster-whisper` (distil-large-v3 or small.en, CTranslate2 INT8). It is open-source and can be **self-hosted**, so no third-party API is required.
9. **Output.** The transcript appears on the OLED and on a live React dashboard.

**Design principle:** *the expensive, privacy-sensitive stage runs only on the rare event that has passed two independent checks.*

---

## 4. What Makes MARVIN Different (The "Why Us" Slide)

| # | Differentiator | Why it matters |
|---|---|---|
| 1 | **Two-stage cascade**, not a single classifier | Published TinyML baselines such as DS-CNN and MobileNet-style KWS models are single-stage. MARVIN adds an independent verifier, which sharply cuts false accepts. |
| 2 | **Heavy compute only on candidates** | Stage-2 and the cloud wake up for a tiny fraction of audio. Average power and bandwidth drop sharply. |
| 3 | **Trained on real-world audio** | We built our own permanent, hash-verified dataset (WAV + SQLite, atomic saves, backups). It includes noisy rooms, different speakers, and hard negatives. |
| 4 | **Hard-negative robustness** | MARGIN, MARINE, NINE and MARTIN are explicitly rejected, while MARVIN is still detected in noise. |
| 5 | **Tiny footprint** | A 17,256-byte INT8 model with about 20.7 K parameters, roughly half the parameters of DS-CNN, at higher accuracy. |
| 6 | **Explicit privacy state machine** | `IDLE → LISTENING → STREAMING`. Audio is neither captured for ASR nor transmitted in `IDLE` or pre-wake `LISTENING`. |
| 7 | **Honest, separated telemetry** | The dashboard keeps offline benchmark results visually separate from live ESP32 latency, heap and score data. We do not mix lab numbers with live numbers. |
| 8 | **Working hardware prototype today** | This is not a mock-up. The ESP32 + INMP441 + OLED runs end-to-end with a live dashboard. |

---

## 5. Measured Results

All six on-device targets were met in our validation.

**Model quality**

| Metric | Result |
|---|---|
| Accuracy | **99.5 %** |
| Precision | **95.9 %** |
| Recall | **95.1 %** |
| F1 score | **95.5 %** |

**ESP32 compliance**

| Target | Result | Status |
|---|---|---|
| Inference latency | **~50 ms** | ✅ |
| CPU load | **~7.4 %** | ✅ |
| RAM | **~114–118 KB** | ✅ |
| Parameters | **~20.7 K (INT8)** | ✅ |
| Model size | **17,256 bytes** | ✅ |
| Cascade verification | **Two independent stages** | ✅ |

*Because the CPU sits at about 7 % while listening, the remaining headroom allows light-sleep scheduling, sensor fusion, or running a second wake word without changing the hardware.*

---

## 6. Technology Stack

| Layer | Technology |
|---|---|
| **Hardware** | ESP32-WROOM-32, INMP441 I²S MEMS microphone, OLED display |
| **Embedded ML** | TensorFlow Lite Micro (INT8 quantised), custom float32 C++ frontend, radix-2 FFT |
| **Training & analysis** | Python, TensorFlow/Keras, MATLAB for signal analysis, our own dataset tooling |
| **Firmware** | Arduino IDE (ESP32 core 3.2.0) and PlatformIO |
| **Backend** | Python FastAPI, WebSocket PCM transport, serial control, SQLite dataset store |
| **ASR** | faster-whisper (CTranslate2, CPU INT8), self-hostable |
| **Dashboard** | React + Three.js: live monitor, waveform, Log-Mel view, pipeline view, model comparison, dataset manager |

---

## 7. The Live Dashboard: Making the Invisible Visible

Judges and users can *see* the intelligence:

- **Live Monitor.** Stage-1 and Stage-2 scores update in real time against their thresholds.
- **Audio Visualizer.** The raw waveform and the Log-Mel features the model actually reads.
- **Detection Pipeline.** Each stage lights up as audio passes through it.
- **ESP32 Runtime Panel.** Live heap, CPU, latency and invocation counts.
- **Live Transcript.** Appears only after wake-word confirmation.
- **Model Comparison.** MARVIN vs. published TinyML baselines, with bar charts and a metrics table.
- **Dataset Manager.** Accept or reject captures, export manifests, and create timestamped backups.

---

## 8. Impact: Who Benefits

| Segment | Benefit |
|---|---|
| **Households and elderly users** | Hands-free control without a device that records the home. |
| **Rural and low-connectivity India** | The wake logic works offline; the cloud is optional and used only on demand. |
| **Assistive technology** | Voice access for visually impaired and motor-impaired users, on a very low-cost board. |
| **Smart agriculture and industry** | Battery-powered voice nodes that last months, for noisy fields and factory floors. |
| **Healthcare** | Privacy-preserving voice triggers in wards and clinics, where audio must not leak. |
| **Education** | An open, hackable reference design that students can build for the cost of a few snacks. |
| **Manufacturers (Make in India)** | A drop-in wake-word IP block that does not depend on foreign cloud APIs. |

**Quantified story for judges:** by gating the cloud behind two on-device checks, MARVIN turns a continuous audio stream into a handful of short, user-initiated utterances. That reduces transmitted audio, energy use, and privacy exposure by orders of magnitude in typical idle-heavy use.

---

## 9. Feasibility and Cost

- **Hardware BOM:** ESP32 DevKit + INMP441 + OLED. This is a hobby-grade bill of materials, and a custom PCB could bring unit cost down substantially.
- **No special silicon.** It runs on a stock ESP32, with no NPU, no PSRAM and no external accelerator.
- **Reproducible.** Build instructions, validation reports, and parity-check tools (`check_frontend.py`, `inspect_model.py`) are in the repository.
- **Offline-capable.** The wake path needs no internet. ASR can run on a local gateway such as a laptop, a Raspberry Pi-class box, or a village-level edge server.

---

## 10. Scalability and Roadmap

| Phase | Goal |
|---|---|
| **Now: prototype** | Single wake word (MARVIN), two-stage cascade, live dashboard, local ASR. |
| **Next: multilingual** | Wake words and commands in Hindi, Tamil, Telugu, Bengali, Marathi and more, using the same cascade recipe with per-language Stage-2 verifiers. |
| **Next: on-device commands** | A small command-set model (lights on/off, call, SOS) that works with **zero cloud**. |
| **Later: personalisation** | Few-shot custom wake words and speaker-aware verification, trained on the user's own device. |
| **Later: deployment** | Custom low-power PCB, light-sleep duty cycling for months-long battery life, and an OTA model-update channel. |
| **Vision: platform** | An open "Edge Voice Kit" that Indian startups and institutions can license or adopt. |

---

## 11. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Noisy environments degrade detection | Real-world noisy training data, an SNR-diverse dataset, and the verifier stage for false-accept control. |
| Accents and speaker variety | Ongoing dataset growth through the built-in dataset manager, and per-language Stage-2 models. |
| Wi-Fi drops during streaming | The wake path is independent of the network. Streaming is bounded (9 s cap) and recovers on the next wake. |
| Hard-negative words (MARGIN, MARTIN, ...) | Explicit hard-negative training and the independent verifier. |
| Privacy trust | The state machine is visible on the OLED, the audio path is open-source and auditable, and nothing leaves the device before verification. |

---

## 12. Alignment With National Priorities

- **Atmanirbhar Bharat / Make in India:** an indigenous, open, self-hostable voice stack.
- **Digital India and Bhashini:** a natural on-ramp for voice-first access in Indian languages.
- **Data privacy (DPDP Act spirit):** privacy by design, with data minimisation enforced in the architecture itself, not only in a policy document.
- **Green computing:** about 7 % CPU duty and a tiny model mean far less energy per interaction.

---

## 13. Winning-Pattern Checklist (What Strong SIH Entries Share)

Past Smart India Hackathon winners tend to share the following traits. MARVIN is built to hit each one.

| Pattern in winning entries | How MARVIN delivers |
|---|---|
| **A real, working prototype**, not slides | ESP32 + mic + OLED running end-to-end, with a live dashboard. |
| **A crisp problem and a clear "why now"** | Cloud-first assistants waste power, add latency, and risk privacy. |
| **Measurable, honest numbers** | 99.5 % accuracy, ~50 ms latency, 7.4 % CPU, 17 KB model, six out of six targets met. |
| **Visible differentiation from existing solutions** | Two-stage cascade vs. single-stage TinyML baselines, shown in a comparison chart. |
| **Social impact and inclusion** | Voice access for rural, elderly, and assistive-technology users. |
| **Low cost and local manufacturing angle** | Stock ESP32, open software, and no foreign API dependency. |
| **Scalability story** | Multilingual, on-device commands, personalisation, and a custom PCB. |
| **A polished demo and storytelling** | 2:15 film, 3D visuals, and a dashboard that makes the AI visible. |
| **Risk awareness** | A mitigation table and a robustness demo with look-alike words. |
| **Clean documentation and reproducibility** | Build guides, validation reports, and parity-check tools. |

---

## 14. The 60-Second Demo Script

1. **Idle.** The OLED shows `IDLE`. The dashboard shows *no audio transmitted*.
2. **Distractors.** Say "Margin… Marine… Martin… Nine." Stage-1 may flicker, but Stage-2 rejects each one and the device stays asleep.
3. **The real thing.** Say **"Hey MARVIN, what is the weather?"** Stage-1 climbs above 0.60, Stage-2 confirms above 0.65, and the pipeline lights up.
4. **Cloud, only now.** The state flips to `STREAMING`. The live transcript appears on the OLED and the dashboard.
5. **Proof.** Point to the runtime panel: ~50 ms latency, 7.4 % CPU, ~114 KB RAM, 17 KB model.
6. **Close:** *"MARVIN. Listen locally, connect when needed."*

---

## 15. Technical Deep Dive: Why the Cascade Works

A single small model has to trade off two goals that pull against each other: **never miss the wake word** (high recall) and **never wake on the wrong word** (low false accepts). Pushing one pushes the other the wrong way. MARVIN splits the job between two models, so each is tuned for one goal.

| Property | Stage-1 (Sentinel) | Stage-2 (Judge) |
|---|---|---|
| **Job** | Cheap, always-on screening | Careful confirmation of candidates only |
| **Tuned for** | High recall (do not miss MARVIN) | High precision (reject look-alikes) |
| **Runs** | Every 500 ms on a rolling window | Only after Stage-1 passes its three-window gate |
| **Decision** | Candidate threshold ~0.60 | Confirmation threshold ~0.65 |
| **Failure it covers** | Missed wake-ups | False wake-ups on MARGIN, MARINE, MARTIN, NINE |

**Why the gate matters.** Stage-1 must fire across a three-window gate before Stage-2 is even invoked. A single noise spike or a door slam cannot trigger anything. This temporal smoothing costs almost nothing and removes a whole class of false triggers.

**Why INT8.** Post-training integer quantisation shrinks the model to 17,256 bytes and uses the ESP32's integer paths, so inference stays near 50 ms with no accelerator.

**Why Log-Mel.** The 98 × 24 Log-Mel representation mimics how human hearing compresses frequency. It is a compact input that keeps the cues separating "MARVIN" from similar-sounding words, and it keeps the first convolution layers small.

**Frontend parity.** A common failure in embedded ML is a mismatch between the training-time and on-device feature code. We prevent it with a parity tool (`check_frontend.py`) that compares our C++ frontend against the TensorFlow reference. What we validate offline is therefore what runs on the chip.

---

## 16. Data and Training Methodology

Models are only as honest as their data. MARVIN's dataset pipeline was built to be auditable.

1. **Permanent, authoritative storage.** Every sample is a 16 kHz mono PCM16 WAV file. A SQLite database is the source of truth for counters, and browser state is never trusted.
2. **Atomic saves.** Captures are staged first and become accepted samples only after the dataset API completes an atomic save. A crash cannot leave a half-written file counted as data.
3. **Integrity checks at startup.** The backend reconciles the database with the filesystem and validates WAV headers and hashes on every start.
4. **Human-in-the-loop curation.** From the dashboard, a reviewer accepts or rejects each candidate, so mislabelled audio does not poison training.
5. **Recoverable mistakes.** Deleted samples go to recoverable trash. Timestamped, non-recursive backups can be created with one click.
6. **Reproducible exports.** CSV manifests are generated from the database, so any training run can be traced to the exact files it used.
7. **Hard negatives by design.** Look-alike words, ambient noise, music, and speech that is not the wake word are first-class classes in the data. They are not afterthoughts.
8. **Separate benchmark.** Offline LibriSpeech-style results are kept visually and logically apart from live ESP32 telemetry. We never present lab numbers as field numbers.

---

## 17. A Day With MARVIN: Two Short Stories

**Kamala, 68, Tamil Nadu village.** She has weak eyesight and a patchy 2G signal. She says "MARVIN, call my son." The wake word is recognised on the device with no internet. Only the short command goes out through a nearby gateway. Her conversations at home never leave the room.

**A greenhouse, Maharashtra.** A battery-powered MARVIN node hangs among the plants. The farmer says "MARVIN, water zone two" with muddy hands. Because the device listens locally at about 7 % CPU, one battery charge lasts far longer than with a cloud-streaming device, and fan and pump noise do not trigger it falsely.

---

## 18. How MARVIN Compares

| Approach | Where the wake decision happens | Privacy | Power | Look-alike rejection | Works offline |
|---|---|---|---|---|---|
| **Cloud-streaming assistant** | Cloud | Weak: audio leaves the device | High: radio always on | Server-side, but after audio is already sent | No |
| **Single-stage TinyML (DS-CNN-class)** | Device | Good | Low | Limited: one threshold for everything | Yes |
| **Proprietary wake-word SDKs** | Device | Good | Low | Varies | Yes, but closed, licensed, and not auditable |
| **MARVIN (two-stage cascade)** | **Device, verified twice** | **Strong: audio leaves only after confirmation** | **Low: Stage-2 and the cloud wake rarely** | **Dedicated independent verifier** | **Yes** |

**Our edge in one sentence:** the accuracy of a bigger model, the footprint of a tiny one, and a privacy guarantee that comes from the architecture itself.

---

## 19. Sustainability and Adoption Plan

- **Open reference design.** Publish the firmware, frontend, and dashboard so colleges, makerspaces and startups can adopt MARVIN. Community contributions add languages and wake words.
- **Institutional pilots.** Start with campus and lab deployments (hostel rooms, labs, libraries) to collect diverse real-world audio and feedback.
- **Assistive-tech partnerships.** Work with NGOs and accessibility groups to test with visually and motor-impaired users, who gain the most from low-cost voice control.
- **Licensing path.** Offer the two-stage cascade as a licensable wake-word module for Indian electronics manufacturers.

---

## 20. Anticipated Judge Questions

**Q1. Why not just use a cloud assistant's wake-word feature?**
Cloud-first designs depend on connectivity and expose audio before the user has intentionally spoken. MARVIN makes the decision locally and sends audio only after verification.

**Q2. Isn't 20 K parameters too small to be accurate?**
It reaches 99.5 % accuracy and 95.5 % F1 on our evaluation, because the cascade gives each small model a narrower job. The second stage handles the confusing cases the first stage was not asked to settle.

**Q3. What happens if Wi-Fi fails?**
Wake detection does not use the network. A failed stream ends at the 9 s cap or the 1.2 s silence rule, and the device returns to listening for the next wake word.

**Q4. How do you prevent accidental recording?**
The device boots in `IDLE`, and audio is neither captured for ASR nor transmitted until Stage-2 confirms the wake word. The state is visible on the OLED and the dashboard.

**Q5. Can it support Indian languages?**
Yes. The recipe (Log-Mel frontend, Stage-1 screening, Stage-2 verification) is language-agnostic. Each new language needs data, not a new architecture.

---

## 21. Closing Statement

Voice should be a convenience, not a surveillance channel. MARVIN shows that a trustworthy voice interface can fit in **17 KB, run on a ₹400 chip, respond in 50 ms, and keep your conversations yours.** It is edge-first by design, verified before it speaks to the cloud, and ready to grow into India's multilingual, privacy-respecting voice future.

**MARVIN: Listen locally, connect when needed.**
