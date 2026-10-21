# MARVIN frontend

Four React pages are available: Home, Live Monitor, Model Comparison, and Dataset. Navigation uses URL hashes and supports browser back/forward.

## Run

```sh
cd ~/sih/frontend
npm run dev
npm run build
```

The backend defaults to the current hostname on port 8011. Override it with `VITE_BACKEND_URL`. The existing `/ws/dashboard` snapshot connection, reconnect behavior, and `KWS_TEST_START` / `KWS_TEST_STOP` commands are retained.

Scores, timing, CPU duty, heap, transcripts, events, and dataset counts use backend snapshots. Disconnected or unavailable measurements render `--`. Stage 2 remains gated unless the device reports an invocation. Dataset categories follow the collector's actual keys, including held-out evaluation categories when present.

The backend publishes real PCM-derived waveform and visualization Log-Mel data on Live Monitor. Fixed validation and held-out benchmark results live in `modelMetrics.js`; live runtime numbers always come from `/ws/dashboard`. Experimental INT8 sizes are rough estimates based on parameter bytes plus the deployed Stage 2 serialization overhead. Power remains unavailable without an external measurement.

The reference images are only used as clipped decorative artwork (hardware illustration, mountains, sky, and Learning Loop branding). The top-right ISRO mark uses the authentic, locally bundled SVG documented in `assets/README.md`. Navigation, text, tables, status indicators, charts, gauges, and cards are React/CSS/SVG components. Vite allows the adjacent `design_refs` directory and bundles the referenced artwork for production; no reference image is a full-page background.

## Visual and integration verification

With the app running, and Python Playwright/Chromium installed:

```sh
MARVIN_FRONTEND_URL=http://127.0.0.1:5173 python3 visual_check.py
```

The default verification URL is port 5174. Screenshots are captured at 1536 × 1024 (the exact reference viewport), 1024 × 768, 768 × 1024, and 390 × 844. Open `visual-review.html` for a reference/screenshot overlay. Screenshots and the layout/error report are saved in `screenshots/`.

The check also runs isolated, test-only WebSocket snapshots to verify score rendering, transcripts, stage-two gating, null metrics, microphone commands, dataset mappings, and disconnection states. These fixtures are never included in the app or saved as visual comparison screenshots. Live hardware/ASR must be connected separately for an end-to-end physical microphone test.
