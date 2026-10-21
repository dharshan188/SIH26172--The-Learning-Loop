# MARVIN backend

The backend owns `/dev/ttyUSB0`, sends serial control commands, receives post-wake PCM16 over WebSocket, and runs `Systran/faster-distil-whisper-large-v3` locally with CTranslate2 CPU INT8. It always sends `STOP_LISTEN` when it opens the serial port.

Run from `backend/` with `./run.sh`. There is no silent fallback model. Valid received utterances are staged beneath the permanent dataset root and only become accepted samples after the dataset API completes an atomic save.

When using a non-default backend port, set `MARVIN_SERVER_PORT` to the same value so the ESP32's Wi-Fi PCM WebSocket reaches the correct listener. Bind to `0.0.0.0` (not `127.0.0.1`) because the ESP32 is a separate network device:

```bash
MARVIN_DISABLE_ASR=1 MARVIN_SERIAL_PORT=/dev/ttyUSB0 MARVIN_SERVER_PORT=8011 \
  uvicorn app:app --host 0.0.0.0 --port 8011
```

The serial link is 115200 baud, 8N1, without flow control. `MARVIN_HEARTBEAT`, `MARVIN_EVENT`, and `MARVIN_METRIC` are newline-delimited text. Post-wake PCM remains on the separate `/ws/esp32` binary WebSocket; serial text can therefore never be parsed as audio. Device status is available at `/api/esp32/status` and is online only while a valid device message has arrived within three seconds.

## Persistent dataset

The default root is `/home/dharshan/sih/marvin_dataset` (override with `MARVIN_DATASET_ROOT`). SQLite, original PCM16 mono 16 kHz WAV files, generated CSV manifests, pending captures, recoverable trash, and non-recursive backups all live below that root. They are never placed in `backend/`, `frontend/`, build output, or `/tmp`.

On every startup the backend reconciles SQLite with the filesystem and validates WAV headers and hashes. Only accepted, non-deleted samples with healthy files contribute to counters. Use the dashboard to accept/reject the latest candidate, export manifests, and create a timestamped backup.
