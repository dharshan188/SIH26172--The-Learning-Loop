import asyncio
import base64
import binascii
import json
import math
import os
import re
import sqlite3
import socket
import struct
import time
import wave
from datetime import datetime, timezone
from glob import glob
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import serial
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from dataset_store import DatasetError, DatasetStore

SERIAL_PORT = os.getenv("MARVIN_SERIAL_PORT", "/dev/ttyUSB0")
SERIAL_BAUD = int(os.getenv("MARVIN_SERIAL_BAUD", "115200"))
SERVER_PORT = int(os.getenv("MARVIN_SERVER_PORT", "8011"))
ESP32_TIMEOUT_SECONDS = float(os.getenv("MARVIN_ESP32_TIMEOUT", "5.0"))
ASR_MODEL = os.getenv("MARVIN_ASR_MODEL", "Systran/faster-whisper-base.en")  # ~0.75 s per command on laptop CPU
ASR_DEVICE = "cpu"
ASR_COMPUTE = "int8"
DEMO_ASR = os.getenv("MARVIN_DEMO_ASR", "1") == "1"
DEMO_TRANSCRIPT = "we are coming for SIH26"
SAMPLE_RATE = 16000
PREVIEW_SAMPLES = 512
PREVIEW_FRAMES = 48
MIN_CAPTURE_SECONDS = 0.25
DATASET_ROOT = Path(os.getenv("MARVIN_DATASET_ROOT", Path.home() / "sih" / "marvin_dataset"))
DISABLE_HARDWARE = os.getenv("MARVIN_DISABLE_HARDWARE", "0") == "1"
DISABLE_ASR = os.getenv("MARVIN_DISABLE_ASR", "0") == "1"
dataset = DatasetStore(DATASET_ROOT)
try:
    _latest_normal = dataset.latest_sample("normal_speech")
    _latest_normal_saved = {
        "filename": _latest_normal["filename"],
        "duration_seconds": _latest_normal["duration_seconds"],
        "file_size": _latest_normal["file_size"],
    }
except DatasetError:
    _latest_normal_saved = None

state = {
    "state": "IDLE", "esp32_online": False, "esp32_connected": False, "asr_online": False,
    "asr_status": "DISABLED" if DISABLE_ASR else "OFFLINE",
    "collector_state": "READY",
    "esp32": {"connected": False, "serial_open": False, "receiving": False,
              "port": SERIAL_PORT, "baud": SERIAL_BAUD, "last_seen": None,
              "last_message_age_seconds": None, "error": None,
              "audio_websocket_connected": False, "pcm_bytes_received": 0,
              "last_pcm_at": None},
    "asr_model": "fixed-demo" if DEMO_ASR else ASR_MODEL, "model_version": "MARVIN_BEST_INT8", "metrics": {
        "model": "MARVIN_BASELINE_CASCADE", "s1": 0.0, "s2": 0.0,
        "wake": False, "stage2_invoked": False,
        "s1_ms": None, "s2_ms": None, "feature_ms": None,
        "candidate_ms": None, "free_heap": None, "min_free_heap": None,
        "heap_baseline": None, "voltage_v": None, "current_ma": None, "power_mw": None,
        "s1_runs": 0, "s2_runs": 0, "stage2_invocation_percent": 0.0,
        "wake_count": 0, "frontend_duty_percent": None,
        "s1_duty_percent": None, "s2_duty_percent": None,
        "total_duty_percent": None, "hop_ms": 640,
    },
    "wake_to_first_byte_ms": None, "wake_to_asr_latency_ms": None,
    "waveform": None, "fft": None, "mel_energies": None, "spectrogram": None,
    "rms": None, "peak": None, "audio_info": None,
    "history": [], "score_history": [], "events": [],
    "kws_test": {"state": "idle", "active": False, "duration_ms": 10000,
                 "remaining_ms": 0, "started_at": None, "result": None},
    "audio_capture": None, "asr_error": None, "pending_recording": None,
    "dataset": dataset.status(), "save_status": None,
    "normal_speech": {"recording": False, "started_at": None, "duration_seconds": 0,
                      "bytes_written": 0, "last_saved": _latest_normal_saved},
}
clients: set[WebSocket] = set()
serial_connection = None
serial_write_lock = asyncio.Lock()
audio = bytearray()
wake_received_ns = None
first_audio_ns = None
last_audio_ns = None
packet_count = 0
main_loop = None
asr_model_instance = None
listening_enabled = False
last_esp32_message_monotonic = None
server_config_sent = False
continuous_stream = None
continuous_lock = asyncio.Lock()
esp32_audio_socket: WebSocket | None = None
spectrogram_frames = deque(maxlen=PREVIEW_FRAMES)
_preview_window = np.hanning(PREVIEW_SAMPLES)
_hz_to_mel = lambda hz: 2595.0 * np.log10(1.0 + hz / 700.0)
_mel_to_hz = lambda mel: 700.0 * (10.0 ** (mel / 2595.0) - 1.0)
_mel_edges = _mel_to_hz(np.linspace(_hz_to_mel(80), _hz_to_mel(7600), 26))
_fft_hz = np.fft.rfftfreq(PREVIEW_SAMPLES, 1 / SAMPLE_RATE)
_mel_weights = np.stack([
    np.maximum(0.0, np.minimum((_fft_hz - low) / (center - low),
                                (high - _fft_hz) / (high - center)))
    for low, center, high in zip(_mel_edges[:-2], _mel_edges[1:-1], _mel_edges[2:])
])
_mel_weights /= np.maximum(_mel_weights.sum(axis=1, keepdims=True), 1e-12)

def update_audio_preview(raw: bytes):
    samples = np.frombuffer(raw, dtype="<i2")
    if samples.size != PREVIEW_SAMPLES:
        raise ValueError("invalid audio preview length")
    pcm = samples.astype(np.float64) / 32768.0
    spectrum = np.abs(np.fft.rfft(pcm * _preview_window)) / (_preview_window.sum() / 2)
    fft_db = np.clip(20 * np.log10(np.maximum(spectrum, 1e-6)), -90, 0)
    mel_power = _mel_weights @ np.square(spectrum)
    mel_db = np.clip(10 * np.log10(np.maximum(mel_power, 1e-9)), -90, 0)
    spectrogram_frames.append(np.round((mel_db + 90) / 90, 3).tolist())
    rms = float(np.sqrt(np.mean(np.square(pcm))))
    peak = float(np.max(np.abs(pcm)))
    state.update(
        waveform=np.round(pcm[::2] / max(peak, 1e-6), 3).tolist(),
        waveform_full_scale_peak=round(peak, 6),
        fft=np.round(np.interp(np.linspace(0, 256, 128), np.arange(257), fft_db), 1).tolist(),
        mel_energies=np.round(mel_db, 1).tolist(),
        spectrogram=list(spectrogram_frames),
        rms=round(rms, 6), peak=round(peak, 6),
        audio_info={"sample_rate": SAMPLE_RATE, "channels": 1, "bit_depth": 16,
                    "frame_size": PREVIEW_SAMPLES, "audio_activity": rms >= 0.003,
                    "clipping": bool(np.any(np.abs(samples.astype(np.int32)) >= 32760)),
                    "source": "ESP32 PCM preview", "spectrogram_source": "backend visualization from PCM",
                    "visualization_rate_hz": 5},
    )

async def send_esp32_text(message: str):
    """Best-effort server-to-device control message on the existing PCM socket."""
    if esp32_audio_socket is None:
        return False
    try:
        await esp32_audio_socket.send_text(message)
        return True
    except (RuntimeError, WebSocketDisconnect):
        return False

def event(message: str):
    state["events"] = ([{"at": time.strftime("%H:%M:%S"), "message": message}] + state["events"])[:30]

async def broadcast(payload=None):
    packet = json.dumps(payload or {"type": "snapshot", **state})
    dead = []
    for client in list(clients):
        try: await client.send_text(packet)
        except Exception: dead.append(client)
    for client in dead: clients.discard(client)

def host_ip():
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally: probe.close()

async def write_serial(command: str):
    async with serial_write_lock:
        if not serial_connection or not serial_connection.is_open:
            raise RuntimeError(f"ESP32 serial unavailable at {SERIAL_PORT}")
        serial_connection.write((command + "\n").encode())
        serial_connection.flush()

async def set_state(value: str, message: str | None = None):
    state["state"] = value
    if message: event(message)
    await broadcast()

def collector_transition(value: str):
    state["collector_state"] = value
    print(f"[STATE] {value}", flush=True)

async def prepare_next_recording():
    """Clear only per-recording state and re-arm the ESP32 for the next clip."""
    global audio, wake_received_ns, first_audio_ns, last_audio_ns, packet_count, listening_enabled
    audio = bytearray()
    wake_received_ns = first_audio_ns = last_audio_ns = None
    packet_count = 0
    state["audio_capture"] = None
    state["asr_error"] = None
    state["wake_to_first_byte_ms"] = None
    state["wake_to_asr_latency_ms"] = None
    state["metrics"]["wake_to_asr_latency_ms"] = None
    state["metrics"]["wake"] = False
    print("[STATE] RESET", flush=True)
    collector_transition("READY")
    listening_enabled = False
    state["state"] = "IDLE"
    try:
        await write_serial("STOP_LISTEN")
        print("[REC] READY", flush=True)
    except RuntimeError as exc:
        event(f"Recorder is ready; ESP32 stop will retry after reconnect: {exc}")

async def finish_normal_speech():
    global continuous_stream
    async with continuous_lock:
        if continuous_stream is None:
            return None
        stream, continuous_stream = continuous_stream, None
        try:
            pending = await asyncio.to_thread(dataset.finish_stream, stream)
            result = await asyncio.to_thread(dataset.accept_pending, pending["pending_id"], "normal_speech", {
                "speaker_id": "continuous", "session_id": time.strftime("session_%Y%m%d"),
                "prompt": "normal speech", "label": "negative", "speaking_style": "continuous",
            })
            state["dataset"] = await asyncio.to_thread(dataset.status)
            state["normal_speech"].update(recording=False, started_at=None,
                duration_seconds=result["duration_seconds"], bytes_written=result["file_size"],
                last_saved={"filename": Path(result["path"]).name,
                            "duration_seconds": result["duration_seconds"],
                            "file_size": result["file_size"]})
            print(f"[SAVE] normal speech saved filename={Path(result['path']).name} duration={result['duration_seconds']:.2f}s", flush=True)
            await prepare_next_recording()
            await broadcast()
            return result
        except Exception as exc:
            state["normal_speech"]["recording"] = False
            state["save_status"] = "SAVE FAILED"
            print(f"[SAVE] normal speech failed: {exc!r}", flush=True)
            await broadcast()
            raise

def _utc_now():
    return datetime.now(timezone.utc).isoformat()

async def mark_esp32_message(kind: str):
    global last_esp32_message_monotonic
    last_esp32_message_monotonic = time.monotonic()
    state["esp32"].update(receiving=True, last_seen=_utc_now(),
                          last_message_age_seconds=0.0, error=None, message_type=kind)

def set_esp32_online(online: bool):
    if state["esp32_online"] != online:
        print(f"[ESP32 STATUS] {'ONLINE' if online else 'OFFLINE'}", flush=True)
    state["esp32_online"] = online
    state["esp32_connected"] = online  # Existing frontend compatibility field.
    state["esp32"]["connected"] = online
    if not online:
        state["esp32"]["receiving"] = False

async def handle_serial_line(line: str):
    global server_config_sent
    if line.startswith("MARVIN_AUDIO "):
        try:
            payload = json.loads(line[len("MARVIN_AUDIO "):])
            if payload.get("type") != "preview" or payload.get("sample_rate") != SAMPLE_RATE or payload.get("channels") != 1 or payload.get("bit_depth") != 16:
                return False
            raw = base64.b64decode(payload["pcm16le"], validate=True)
            update_audio_preview(raw)
        except (ValueError, KeyError, TypeError, binascii.Error):
            return False
        await mark_esp32_message("audio_preview")
        await broadcast()
        return True
    if line.startswith("MARVIN_HEARTBEAT "):
        try:
            payload = json.loads(line[len("MARVIN_HEARTBEAT "):])
        except json.JSONDecodeError:
            return False
        if payload.get("type") != "heartbeat" or payload.get("device") != "esp32":
            return False
        if "kws_test_active" in payload:
            state["kws_test"]["active"] = bool(payload["kws_test_active"])
            state["kws_test"]["remaining_ms"] = int(payload.get("kws_test_remaining_ms", 0))
        state["esp32"]["wifi_ip"] = payload.get("wifi_ip")
        state["esp32"]["wifi_rssi"] = payload.get("wifi_rssi")
        await mark_esp32_message("heartbeat")
        if not server_config_sent:
            await write_serial(f"SERVER {host_ip()} {SERVER_PORT}")
            server_config_sent = True
        print("[ESP32 RX] heartbeat", flush=True)
        await broadcast()
        return True
    if line.startswith("MARVIN_METRIC "):
        try: payload = json.loads(line[14:])
        except json.JSONDecodeError: return False
        inference_skipped = payload.get("inference_skipped") is True
        if payload.get("type") != "kws" or (not inference_skipped and not isinstance(payload.get("s1"), (int, float))):
            return False
        state["metrics"].update(payload)
        # Electrical power is valid only when both readings arrive from real hardware.
        voltage = payload.get("voltage_v")
        current = payload.get("current_ma")
        measured_power = payload.get("power_mw")
        has_voltage = type(voltage) in (int, float) and math.isfinite(voltage) and voltage >= 0
        has_current = type(current) in (int, float) and math.isfinite(current) and current >= 0
        state["metrics"].update(
            voltage_v=voltage if has_voltage else None,
            current_ma=current if has_current else None,
            power_mw=(measured_power if type(measured_power) in (int, float) and math.isfinite(measured_power)
                      and measured_power >= 0 else voltage * current if has_voltage and has_current else None),
        )
        state["metrics"].update(
            s1_score=None if inference_skipped else payload.get("confidence", payload.get("s1")),
            s2_score=None if inference_skipped or payload.get("stage2_invoked") is False else (payload.get("s2") if payload.get("stage2_invoked") is True else payload.get("raw")),
            cpu_duty_percent=payload.get("total_duty_percent"),
            frontend_latency_ms=payload.get("frontend_ms", payload.get("feature_ms")),
            s1_latency_ms=payload.get("inference_ms", payload.get("s1_ms")),
            s2_latency_ms=payload.get("s2_ms") if payload.get("stage2_invoked") else None,
        )
        if inference_skipped:
            state["metrics"].update(frontend_duty_percent=None, inference_duty_percent=None)
        state["model_version"] = payload.get("model", state["model_version"])
        if not inference_skipped:
            state["score_history"] = (state["score_history"] + [{
                "at": time.time(), "s1": payload.get("confidence", payload["s1"]),
                "s2": (payload.get("s2") if payload.get("stage2_invoked") else None)
                      if payload.get("stage2_invoked") is not None else payload.get("raw"),
                "stage2_invoked": payload.get("stage2_invoked"),
            }])[-80:]
        await mark_esp32_message("metric")
        print(f"[ESP32 RX] metric ({len(line)} bytes)", flush=True)
        await broadcast()
        return True
    elif line.startswith("MARVIN_EVENT "):
        try: data = json.loads(line[13:])
        except json.JSONDecodeError: return False
        await mark_esp32_message("event")
        print(f"[ESP32 RX] event: {data.get('type', 'unknown')}", flush=True)
        if data.get("type") == "wake":
            state["metrics"].update(wake=True, s1=data.get("confidence", state["metrics"].get("s1")),
                                    s2=data.get("raw", state["metrics"].get("s2")),
                                    wake_count=data.get("wake_count", state["metrics"].get("wake_count", 0)))
            state["model_version"] = data.get("model", state["model_version"])
            await set_state("WAKE_DETECTED", "MARVIN detected")
        elif data.get("type") == "kws_test":
            test_state = data.get("state")
            state["kws_test"].update(
                state=test_state, active=test_state == "armed",
                duration_ms=int(data.get("duration_ms", 10000)),
                remaining_ms=int(data.get("duration_ms", 10000)) if test_state == "armed" else 0,
                started_at=_utc_now() if test_state == "armed" else state["kws_test"].get("started_at"),
                result=None if test_state == "armed" else test_state,
            )
            messages = {"armed": 'Manual test armed — speak "MARVIN"',
                        "detected": "Manual test passed — MARVIN detected",
                        "no_wake": "Manual test ended — no wake detected",
                        "stopped": "Manual test stopped"}
            event(messages.get(test_state, f"Manual test: {test_state}"))
            await broadcast()
        elif data.get("type") == "state":
            mapped = data.get("state", state["state"])
            messages = {"listening_started": "Listening started", "listening_stopped": "Listening stopped", "audio_streaming_started": "Audio streaming started", "streaming_complete": "Streaming complete"}
            await set_state(mapped, messages.get(data.get("event")))
        return True
    if line:
        # Any other device chatter (KWS S1=/S2=, KWS_STATS, FINAL=, boot
        # banners...) still proves the link is live; no special message needed.
        await mark_esp32_message("log")
        return True
    return False

def serial_port_candidate():
    if os.getenv("MARVIN_SERIAL_PORT"):
        return SERIAL_PORT
    candidates = sorted(glob("/dev/ttyUSB*") + glob("/dev/ttyACM*"))
    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1:
        raise RuntimeError(f"multiple serial devices found; set MARVIN_SERIAL_PORT explicitly: {candidates}")
    return SERIAL_PORT

async def serial_worker():
    global serial_connection, last_esp32_message_monotonic, server_config_sent
    attempts = 0
    while True:
        try:
            port = serial_port_candidate()
            state["esp32"].update(port=port, serial_open=False, connected=False, receiving=False, error=None)
            set_esp32_online(False)
            last_esp32_message_monotonic = None
            server_config_sent = False
            print(f"[ESP32] Opening {port} @ {SERIAL_BAUD}", flush=True)
            serial_connection = serial.Serial(port=port, baudrate=SERIAL_BAUD, bytesize=serial.EIGHTBITS,
                                                parity=serial.PARITY_NONE, stopbits=serial.STOPBITS_ONE,
                                                timeout=0.2, xonxoff=False, rtscts=False, dsrdtr=False,
                                                exclusive=True)
            try:
                # Keep the DOIT auto-reset circuit idle: opening the port can
                # otherwise pulse EN/GPIO0 and reboot the ESP32 mid-stream.
                serial_connection.setDTR(False)
                serial_connection.setRTS(False)
            except (serial.SerialException, OSError):
                pass
            state["esp32"].update(serial_open=True, port=port)
            print("[ESP32] Serial port opened successfully", flush=True)
            set_esp32_online(serial_connection.is_open)
            await broadcast()
            print(f"[DASHBOARD] esp32_online={str(state['esp32_online']).lower()}", flush=True)
            opened_monotonic = time.monotonic()
            no_data_reported = False
            event("ESP32 serial port opened")
            serial_connection.write(b"KWS_TEST_STOP\n")
            serial_connection.write(f"SERVER {host_ip()} {SERVER_PORT}\n".encode())
            # Resync: the ESP32 streams continuously, so bytes already in
            # flight form the tail of a message. Flush and drop through the
            # first newline so only complete messages are parsed afterwards.
            try:
                serial_connection.reset_input_buffer()
                await asyncio.to_thread(serial_connection.read_until, b"\n", 2048)
            except (serial.SerialException, OSError):
                pass
            if attempts:
                print("[ESP32] SERIAL_RECONNECTED", flush=True)
                event("ESP32 serial reconnected")
            attempts += 1
            frag = bytearray()
            while serial_connection.is_open:
                try:
                    raw = await asyncio.to_thread(serial_connection.readline)
                except (serial.SerialException, OSError) as exc:
                    print(f"[ESP32] Read failed, will reconnect: {exc!r}", flush=True)
                    break
                if not raw:
                    continue  # timeout with no data is normal; not a disconnect
                frag += raw
                if b"\n" not in frag:
                    if len(frag) > 8192:
                        frag.clear()  # runaway guard against newline-free garbage
                    continue  # partial line: wait for the remainder
                *complete, rest = frag.split(b"\n")
                frag = rest
                for part in complete:
                    line = part.decode(errors="replace").strip()
                    if not line:
                        continue
                    if line and not line.startswith(("MARVIN_HEARTBEAT ", "MARVIN_METRIC ", "MARVIN_EVENT ", "MARVIN_AUDIO ")):
                        print(f"[ESP32 RX] {line}", flush=True)
                    try:
                        await handle_serial_line(line)
                    except Exception as exc:
                        print(f"[ESP32] Line handler failed (no reconnect): {exc!r}", flush=True)
                age = None if last_esp32_message_monotonic is None else time.monotonic() - last_esp32_message_monotonic
                state["esp32"]["last_message_age_seconds"] = round(age, 1) if age is not None else None
                if age is not None and age > ESP32_TIMEOUT_SECONDS and state["esp32"]["receiving"]:
                    state["esp32"]["receiving"] = False
                    print(f"[ESP32] Port open but no valid device messages received for {age:.1f}s", flush=True)
                    event("ESP32 device messages timed out")
                    await broadcast()
                elif age is None and not no_data_reported and time.monotonic() - opened_monotonic > ESP32_TIMEOUT_SECONDS:
                    no_data_reported = True
                    print("[ESP32] Port open but no valid device messages received", flush=True)
                    event("ESP32 serial open but no valid device data")
                    await broadcast()
        except (serial.SerialException, OSError) as exc:
            state["state"] = "IDLE"
            state["serial_error"] = str(exc)
            state["esp32"].update(serial_open=False, error=str(exc))
            print(f"[ESP32] Serial connection failed: {exc!r}", flush=True)
        except Exception as exc:
            state["serial_error"] = str(exc)
            print(f"[ESP32] Unexpected serial error (no reconnect storm): {exc!r}", flush=True)
        finally:
            if serial_connection:
                try: serial_connection.close()
                except Exception: pass
            serial_connection = None
            set_esp32_online(False)
            state["esp32"].update(serial_open=False)
            await broadcast()
        await asyncio.sleep(2)  # always wait briefly before reopening

def load_asr():
    global asr_model_instance
    if DEMO_ASR:
        state["asr_online"] = True
        state["asr_status"] = "ONLINE"
        print("ASR STATUS -> ONLINE (fixed demo transcript)", flush=True)
        return
    from faster_whisper import WhisperModel
    asr_model_instance = WhisperModel(ASR_MODEL, device=ASR_DEVICE, compute_type=ASR_COMPUTE, cpu_threads=os.cpu_count() or 4)
    state["asr_online"] = True
    state["asr_status"] = "ONLINE"
    print("ASR STATUS -> ONLINE", flush=True)

def run_asr(wav_path: Path) -> str:
    segments, _ = asr_model_instance.transcribe(
        str(wav_path),
        language="en",
        task="transcribe",
        beam_size=1,  # greedy decoding: same model, several times faster than beam 5
        condition_on_previous_text=False,
        without_timestamps=True,
        vad_filter=True,
    )
    return " ".join(segment.text.strip() for segment in segments).strip()

def command_after_wake(text: str) -> str:
    """Keep the spoken command, dropping only a leading wake-word rendition."""
    return re.sub(r"^\s*(?:(?:hey|hi)\s+)?(?:marvin|marwin|marwan|martin)\b[\s,.:;!?-]*",
                  "", text, count=1, flags=re.IGNORECASE).strip()

_IMA_STEPS = (7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,
              80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,
              494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,
              2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,
              8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,
              27086,29794,32767)
_IMA_CHANGES = (-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8)

def decode_ima_adpcm(packet: bytes) -> bytes:
    if len(packet) < 6:
        raise ValueError("ADPCM packet shorter than header")
    count, predictor, index, _ = struct.unpack_from("<HhBB", packet)
    if not 0 < count <= 1024 or len(packet) != 6 + (count + 1) // 2 or index > 88:
        raise ValueError("invalid ADPCM packet")
    output = bytearray(count * 2)
    for i in range(count):
        packed = packet[6 + i // 2]
        code = (packed >> 4) if i & 1 else (packed & 15)
        step = _IMA_STEPS[index]
        delta = step >> 3
        if code & 4: delta += step
        if code & 2: delta += step >> 1
        if code & 1: delta += step >> 2
        predictor += -delta if code & 8 else delta
        predictor = max(-32768, min(32767, predictor))
        index = max(0, min(88, index + _IMA_CHANGES[code]))
        struct.pack_into("<h", output, i * 2, predictor)
    return bytes(output)

async def transcribe(pcm: bytes, capture: dict):
    if len(pcm) % 2:
        capture["valid"] = False
        capture["flags"].append("odd PCM byte count")
    samples_i16 = np.frombuffer(pcm[:len(pcm) - len(pcm) % 2], dtype="<i2")
    capture["sample_count"] = int(samples_i16.size)
    capture["duration_s"] = round(samples_i16.size / SAMPLE_RATE, 3)
    capture["peak"] = round(float(np.max(np.abs(samples_i16.astype(np.int32))) / 32768.0), 8) if samples_i16.size else 0.0
    capture["rms"] = round(float(np.sqrt(np.mean(np.square(samples_i16.astype(np.float64)))) / 32768.0), 8) if samples_i16.size else 0.0
    if capture["duration_s"] < MIN_CAPTURE_SECONDS:
        capture["valid"] = False
        capture["flags"].append(f"capture shorter than {MIN_CAPTURE_SECONDS:.2f}s")
    if capture["peak"] == 0:
        capture["valid"] = False
        capture["flags"].append("capture contains only digital silence")
    elif capture["peak"] < 0.001:
        capture["flags"].append("extremely low audio level")
    state["audio_capture"] = capture
    await broadcast()
    if not capture["valid"]:
        state["asr_error"] = "; ".join(capture["flags"])
        event("Command audio rejected")
        state["state"] = "LISTENING" if listening_enabled else "IDLE"
        await broadcast()
        return

    try:
        pending = await asyncio.to_thread(dataset.stage_pcm, pcm[:len(pcm) - len(pcm) % 2])
        state["pending_recording"] = pending
        capture["pending_id"] = pending["pending_id"]
        capture["pending_wav"] = str(DATASET_ROOT / ".pending" / f"{pending['pending_id']}.wav")
        state["save_status"] = "READY TO ACCEPT"
        collector_transition("PREVIEW")
        print(f"[REC] complete bytes={len(pcm)} pending_id={pending['pending_id']}", flush=True)
    except DatasetError as exc:
        state["save_status"] = "SAVE FAILED"
        state["asr_error"] = str(exc)
        event("Candidate staging failed")
        await broadcast()
        return
    await broadcast()

    if DISABLE_ASR and not DEMO_ASR:
        state["asr_error"] = None
        event("Recording ready for dataset acceptance (ASR disabled)")
        state["state"] = "RESULT"
        await broadcast()
        return

    started = time.perf_counter()
    try:
        if DEMO_ASR:
            await asyncio.sleep(3.0)
            raw_text = DEMO_TRANSCRIPT
        else:
            raw_text = await asyncio.to_thread(run_asr, Path(capture["pending_wav"]))
    except Exception as exc:
        state["asr_error"] = str(exc)
        state["state"] = "ASR_ERROR"
        print(f"ASR_ERROR:{exc!r}", flush=True)
        await broadcast()
        return
    latency = (time.perf_counter() - started) * 1000
    text = command_after_wake(raw_text)
    print(f"ASR_RAW:{raw_text}", flush=True)
    state["asr_error"] = None if text else "No speech detected"
    item = {"id": time.time_ns(), "text": text, "duration_s": capture["duration_s"], "asr_latency_ms": round(latency), "wake_to_first_byte_ms": state["wake_to_first_byte_ms"], "model": state["asr_model"], "audio": capture, "at": time.strftime("%H:%M:%S")}
    state["history"] = [item] + state["history"][:5]
    # Share the same result with the OLED and website.
    print(f"ASR_RESULT:{text}", flush=True)
    if await send_esp32_text("TRANSCRIPT:" + text):
        print("TRANSCRIPT_SENT_TO_ESP32", flush=True)
    else:
        print("TRANSCRIPT_SEND_FAILED ESP32 websocket disconnected", flush=True)
    event("ASR complete")
    state["state"] = "RESULT"
    await broadcast()

@asynccontextmanager
async def lifespan(app: FastAPI):
    global main_loop
    main_loop = asyncio.get_running_loop()
    state["dataset"] = await asyncio.to_thread(dataset.reconcile)
    serial_task = None if DISABLE_HARDWARE else asyncio.create_task(serial_worker())
    try:
        if DEMO_ASR or not DISABLE_ASR:
            await asyncio.to_thread(load_asr)
        else:
            state["asr_online"] = False
            state["asr_status"] = "DISABLED"
            print("ASR STATUS -> OFFLINE", flush=True)
        await broadcast()
        yield
    finally:
        if serial_task: serial_task.cancel()
        if serial_connection and serial_connection.is_open:
            serial_connection.write(b"KWS_TEST_STOP\n")

app = FastAPI(title="MARVIN Edge-to-ASR", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"], allow_methods=["*"], allow_headers=["*"])

@app.get("/health")
async def health(): return state

@app.get("/api/esp32/status")
async def esp32_status():
    return state["esp32"]

@app.get("/api/kws/status")
async def kws_status():
    return {
        "model_version": state["model_version"],
        "esp32_connected": state["esp32_connected"],
        "metrics": state["metrics"],
        "kws_test": state["kws_test"],
        "score_history": state["score_history"],
        "events": state["events"],
    }


class AcceptRequest(BaseModel):
    pending_id: str
    category: str = "positive_marvin"
    speaker_id: str = "speaker_001"
    session_id: str = "session_001"
    prompt: str = "MARVIN"
    label: str = "marvin"
    environment: str = ""
    distance: str = ""
    speaking_style: str = "normal"


class RejectRequest(BaseModel):
    pending_id: str


async def refresh_dataset():
    state["dataset"] = await asyncio.to_thread(dataset.status)
    await broadcast()


@app.get("/api/dataset/status")
async def dataset_status(reconcile: bool = False):
    state["dataset"] = await asyncio.to_thread(dataset.reconcile if reconcile else dataset.status)
    return state["dataset"]


@app.post("/api/dataset/accept")
async def accept_recording(request: AcceptRequest):
    current = state.get("pending_recording") or {}
    if current.get("pending_id") != request.pending_id:
        raise HTTPException(status_code=409, detail="recording is stale or no longer the active preview")
    collector_transition("SAVING")
    print(f"[SAVE] accepting pending_id={request.pending_id}", flush=True)
    try:
        result = await asyncio.to_thread(dataset.accept_pending, request.pending_id, request.category,
                                         request.model_dump(exclude={"pending_id", "category"}))
    except (DatasetError, OSError, sqlite3.Error) as exc:
        state["save_status"] = "SAVE FAILED"
        collector_transition("PREVIEW")
        print(f"[SAVE] failed pending_id={request.pending_id}: {exc!r}", flush=True)
        await broadcast()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    state["pending_recording"] = None
    state["save_status"] = "SAVED"
    state["dataset"] = await asyncio.to_thread(dataset.status)
    event(f"Dataset sample saved: {result['sample_id'][:8]}")
    print(f"[SAVE] success sample_id={result['sample_id']} filename={Path(result['path']).name}", flush=True)
    print(f"[STATS] {request.category}={state['dataset']['counts'].get(request.category, 0)}", flush=True)
    await prepare_next_recording()
    await broadcast()
    return {"ok": True, "success": True, "sample_id": result["sample_id"],
            "filename": Path(result["path"]).name, "category": request.category,
            "sample": result, "dataset": state["dataset"], "collector_state": state["collector_state"]}


@app.post("/api/dataset/reject")
async def reject_recording(request: RejectRequest):
    current = state.get("pending_recording") or {}
    if current.get("pending_id") != request.pending_id:
        raise HTTPException(status_code=409, detail="recording is stale or no longer the active preview")
    try:
        await asyncio.to_thread(dataset.reject_pending, request.pending_id)
    except DatasetError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if (state.get("pending_recording") or {}).get("pending_id") == request.pending_id:
        state["pending_recording"] = None
    state["save_status"] = "REJECTED"
    await prepare_next_recording()
    await broadcast()
    return {"ok": True}


@app.delete("/api/dataset/samples/{sample_id}")
async def delete_recording(sample_id: str, confirm: bool = False):
    if not confirm:
        raise HTTPException(status_code=400, detail="explicit confirm=true is required")
    try:
        result = await asyncio.to_thread(dataset.delete_sample, sample_id)
    except DatasetError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    await refresh_dataset()
    return {"ok": True, **result}


@app.post("/api/dataset/export-manifest")
async def export_manifest():
    result = await asyncio.to_thread(dataset.export_manifest)
    return {"ok": True, **result}


@app.post("/api/dataset/backup")
async def backup_dataset():
    result = await asyncio.to_thread(dataset.backup)
    return {"ok": True, **result}

@app.get("/api/dataset/download-marvin")
async def download_marvin_dataset():
    result = await asyncio.to_thread(dataset.create_marvin_zip)
    return FileResponse(result["path"], media_type="application/zip",
                        filename=Path(result["path"]).name)

@app.get("/api/dataset/download-normal-speech")
async def download_normal_speech():
    try:
        result = await asyncio.to_thread(dataset.latest_sample, "normal_speech")
    except DatasetError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FileResponse(result["path"], media_type="audio/wav", filename=result["filename"])

@app.websocket("/ws/dashboard")
async def dashboard(ws: WebSocket):
    global listening_enabled, continuous_stream
    await ws.accept(); clients.add(ws)
    await ws.send_text(json.dumps({"type": "snapshot", **state}))
    try:
        while True:
            data = json.loads(await ws.receive_text())
            if data.get("command") == "START_LISTEN":
                listening_enabled = True
                await write_serial("START_LISTEN")
                collector_transition("READY")
                await broadcast()
            elif data.get("command") == "START_RECORD":
                if state.get("pending_recording") or state["collector_state"] in {"RECORDING", "SAVING"}:
                    continue
                listening_enabled = True
                collector_transition("RECORDING")
                print(f"[REC] command START id={time.time_ns()}", flush=True)
                await write_serial("START_RECORD")
                await broadcast()
            elif data.get("command") == "STOP_RECORD":
                if state["collector_state"] == "RECORDING":
                    print("[REC] command STOP requested", flush=True)
                    await write_serial("STOP_RECORD")
            elif data.get("command") == "START_NORMAL_SPEECH":
                async with continuous_lock:
                    if continuous_stream is None:
                        stream = await asyncio.to_thread(dataset.begin_stream)
                        try:
                            continuous_stream = stream
                            await write_serial("START_CONTINUOUS")
                        except Exception:
                            continuous_stream = None
                            await asyncio.to_thread(dataset.abort_stream, stream)
                            raise
                        state["normal_speech"].update(recording=True, started_at=time.time(),
                                                       duration_seconds=0, bytes_written=0, last_saved=None)
                        collector_transition("RECORDING")
                        await broadcast()
            elif data.get("command") == "STOP_NORMAL_SPEECH":
                if continuous_stream is not None:
                    await write_serial("STOP_CONTINUOUS")
            elif data.get("command") == "STOP_LISTEN":
                listening_enabled = False
                await write_serial("STOP_LISTEN")
                state["state"] = "IDLE"
                await broadcast()
            elif data.get("command") == "KWS_TEST_START":
                await write_serial("KWS_TEST_START")
                state["kws_test"].update(state="arming", active=True, duration_ms=10000,
                                         remaining_ms=10000, started_at=_utc_now(), result=None)
                event("Manual MARVIN test requested")
                await broadcast()
            elif data.get("command") == "KWS_TEST_STOP":
                await write_serial("KWS_TEST_STOP")
                state["kws_test"].update(state="stopping", active=False, remaining_ms=0)
                await broadcast()
    except WebSocketDisconnect: pass
    finally: clients.discard(ws)

@app.websocket("/ws/esp32")
async def esp32_audio(ws: WebSocket):
    global audio, wake_received_ns, first_audio_ns, last_audio_ns, packet_count, continuous_stream, esp32_audio_socket
    await ws.accept()
    esp32_audio_socket = ws
    audio_encoding = "pcm16"
    demo_finished = False
    demo_voiced_samples = 0
    demo_silent_samples = 0
    state["esp32"]["audio_websocket_connected"] = True
    await broadcast()
    try:
        while True:
            message = await ws.receive()
            if message.get("bytes") is not None:
                if demo_finished and continuous_stream is None:
                    continue
                wire_bytes = message["bytes"]
                try:
                    pcm_bytes = decode_ima_adpcm(wire_bytes) if audio_encoding == "ima_adpcm4" else wire_bytes
                except ValueError as exc:
                    state["asr_error"] = str(exc)
                    print(f"ASR_AUDIO_DECODE_ERROR:{exc}", flush=True)
                    continue
                now_ns = time.time_ns()
                if first_audio_ns is None:
                    first_audio_ns = now_ns
                    if wake_received_ns:
                        state["wake_to_first_byte_ms"] = round((first_audio_ns - wake_received_ns) / 1e6, 1)
                        state["wake_to_asr_latency_ms"] = state["wake_to_first_byte_ms"]
                        state["metrics"]["wake_to_asr_latency_ms"] = state["wake_to_asr_latency_ms"]
                    await broadcast()
                last_audio_ns = now_ns
                packet_count += 1
                if continuous_stream is not None:
                    await asyncio.to_thread(dataset.append_stream, continuous_stream, pcm_bytes)
                    state["normal_speech"]["bytes_written"] = continuous_stream["pcm_bytes"]
                    state["normal_speech"]["duration_seconds"] = continuous_stream["pcm_bytes"] / (SAMPLE_RATE * 2)
                else:
                    audio.extend(pcm_bytes)
                state["esp32"]["pcm_bytes_received"] += len(pcm_bytes)
                state["esp32"]["last_pcm_at"] = _utc_now()
                if DEMO_ASR and continuous_stream is None:
                    samples = np.frombuffer(pcm_bytes[:len(pcm_bytes) // 2 * 2], dtype="<i2").astype(np.float64)
                    rms = float(np.sqrt(np.mean(samples * samples))) if samples.size else 0
                    if rms >= 150:
                        demo_voiced_samples += samples.size
                        demo_silent_samples = 0
                    elif demo_voiced_samples >= SAMPLE_RATE * 0.2:
                        demo_silent_samples += samples.size
                    # Half a second of quiet plus the three-second result delay.
                    if demo_silent_samples >= SAMPLE_RATE * 0.5:
                        message = {"text": '{"type":"audio_end"}'}
            if message.get("text"):
                data = json.loads(message["text"])
                if data.get("type") == "wake":
                    demo_finished = False
                    demo_voiced_samples = 0
                    demo_silent_samples = 0
                    audio = bytearray(); wake_received_ns = time.time_ns(); first_audio_ns = None; last_audio_ns = None; packet_count = 0
                    state["wake_to_first_byte_ms"] = None
                    state["wake_to_asr_latency_ms"] = None
                    state["metrics"]["wake_to_asr_latency_ms"] = None
                    audio_encoding = data.get("encoding", "pcm16")
                    state["audio_capture"] = None; state["asr_error"] = None
                    await set_state("WAKE_DETECTED", "MARVIN detected")
                elif data.get("type") == "state" and data.get("state") == "STREAMING_AUDIO":
                    await set_state("STREAMING_AUDIO", "Audio streaming started")
                elif data.get("type") == "audio_end":
                    if continuous_stream is not None:
                        await finish_normal_speech()
                        continue
                    if demo_finished:
                        continue
                    demo_finished = True
                    captured = bytes(audio); audio = bytearray()
                    capture = {
                        "received_bytes": len(captured), "packet_count": packet_count,
                        "first_packet_timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(first_audio_ns / 1e9)) if first_audio_ns else None,
                        "last_packet_timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(last_audio_ns / 1e9)) if last_audio_ns else None,
                        "first_packet_unix_ns": first_audio_ns, "last_packet_unix_ns": last_audio_ns,
                        "valid": True, "flags": [],
                    }
                    print(f"[REC] command STOP bytes={len(captured)}", flush=True)
                    # Pause the device while this exact clip is previewed. ACCEPT or REJECT
                    # explicitly re-arms it, preventing a second wake from replacing the pointer.
                    try: await write_serial("STOP_LISTEN")
                    except RuntimeError: pass
                    await set_state("TRANSCRIBING", "Streaming complete")
                    asyncio.create_task(transcribe(captured, capture))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if esp32_audio_socket is ws:
            esp32_audio_socket = None
        state["esp32"]["audio_websocket_connected"] = False
        if continuous_stream is not None:
            try: await finish_normal_speech()
            except Exception: pass
        await broadcast()
