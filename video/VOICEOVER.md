# MARVIN: SIH 2026 film voice-over script (2:15)

Video: `out/MARVIN_SIH2026_3D_1080p.mp4` (1920×1080, 30 fps, 2:15, no audio track).
Pace: about 150 words per minute. Keep each line inside its time slot.

| Time | Scene on screen | Voice-over |
|---|---|---|
| 0:00 – 0:06 | **Opening.** MARVIN title, PS ID SIH26172, Team ID 158994. | "SIH 2026, problem statement SIH26172. We are The Learning Loop, and this is MARVIN." |
| 0:06 – 0:15 | **01 · Why MARVIN?** Speaker streaming to the cloud, battery draining. | "Today's assistants are cloud-first. They stream audio nonstop just to catch one wake word, which wastes power, adds latency and risks privacy." |
| 0:15 – 0:30 | **02 · Our solution.** 3D ESP32, mic and OLED, then the real prototype photo. | "MARVIN is edge-first. The wake word is detected right on an ESP32 with an INMP441 mic and an OLED, and the cloud is used only after verification. Here is our working prototype." |
| 0:30 – 0:38 | **03 · Why we stand out.** | "What makes it unique: a two-stage cascade, heavy compute only on candidates, and training on real-world audio." |
| 0:38 – 0:50 | **04 · Technologies used.** | "It's built with ESP32, TensorFlow Lite Micro, Python, MATLAB, the Arduino IDE and React." |
| 0:50 – 0:53.5 | **05 · Workflow 01: Voice input** | "Say: 'Hey MARVIN, what is the weather?'" |
| 0:53.5 – 0:57 | **02: Audio capture** | "The INMP441 records sixteen-kilohertz audio…" |
| 0:57 – 1:00.5 | **03: Preprocessing** | "…turned into 98-by-24 Log-Mel features." |
| 1:00.5 – 1:04 | **04: Stage-1 CNN** | "Stage one flags a candidate above 0.60…" |
| 1:04 – 1:07.5 | **05: Stage-2 verification** | "…stage two confirms it above 0.65." |
| 1:07.5 – 1:11 | **06: Wake word confirmed** | "Look-alike words are rejected." |
| 1:11 – 1:14.5 | **07: Cloud ASR** | "Only now does audio reach the cloud…" |
| 1:14.5 – 1:18 | **08: Output** | "…and the transcript appears on the OLED and dashboard." |
| 1:18 – 1:25 | **06 · Robustness.** MARGIN, MARINE, NINE and MARTIN rejected; MARVIN detected in noise. | "It ignores MARGIN, MARINE, NINE and MARTIN, yet still hears MARVIN in real-world noise." |
| 1:25 – 1:28.5 | **07 · Dashboard: live monitor.** Stage-1 & Stage-2 scores highlighted. | "Our dashboard shows it all live. Stage one flags a candidate above 0.60, stage two confirms above 0.65." |
| 1:28.5 – 1:32 | Waveform + Log-Mel highlighted. | "Here is what the mic hears, and the Log-Mel features the model reads." |
| 1:32 – 1:38 | Detection pipeline, then ESP32 runtime highlighted. | "Each pipeline stage lights up as it passes, while the ESP32 reports 118 kilobytes of RAM and 7.4 percent CPU." |
| 1:38 – 1:40.5 | Live transcript highlighted. | "Audio reaches the cloud only after the wake word is confirmed." |
| 1:40.5 – 1:50 | **Dashboard: model comparison.** Final model, baseline table, bar charts. | "Compared with published TinyML baselines, MARVIN is the only one with a two-stage check, and it gets higher accuracy with about half the parameters of DS-CNN." |
| 1:50 – 1:58 | **08 · Model performance.** Gauges. | "Accuracy is 99.5 percent, precision 95.9, recall 95.1, and F1 95.5." |
| 1:58 – 2:09 | **09 · Compliance.** Same gauge style: latency, CPU, RAM, parameters. | "On the ESP32: about 50 milliseconds latency, 7.4 percent CPU, 114 kilobytes of RAM and 20.7 thousand INT8 parameters. Six of six targets met." |
| 2:09 – 2:15 | **Closing.** Fades to black. | "MARVIN. Listen locally, connect when needed." |

## Recording tips
- Record each row as its own take. That makes timing easy to adjust in your editor.
- The workflow captions change every 3.5 seconds. Start each line as its caption appears.
- The film fades in from black and back to black in the last 1.4 seconds, so cuts into your prototype demo will be clean.
