"""Exercise repeated PCM preview/accept cycles through the running backend API."""

import argparse
import asyncio
import math
import struct
import time

import requests
import websockets


async def send_pcm(ws_url: str, index: int):
    pcm = b"".join(
        struct.pack("<h", int(5000 * math.sin(2 * math.pi * (300 + index * 17) * i / 16000)))
        for i in range(16000)
    )
    async with websockets.connect(ws_url) as ws:
        await ws.send('{"type":"wake","test":true}')
        await ws.send('{"type":"state","state":"STREAMING_AUDIO"}')
        for offset in range(0, len(pcm), 640):
            await ws.send(pcm[offset:offset + 640])
        await ws.send('{"type":"audio_end","duration_ms":1000}')


def wait_for_preview(base: str, previous_id: str | None):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        snapshot = requests.get(f"{base}/health", timeout=2).json()
        pending = snapshot.get("pending_recording")
        if pending and pending["pending_id"] != previous_id and snapshot["collector_state"] == "PREVIEW":
            return pending
        time.sleep(0.05)
    raise AssertionError("backend did not reach PREVIEW with a new recording")


async def main(base: str, cycles: int):
    previous_id = None
    for index in range(1, cycles + 1):
        print(f"[STATE] RECORDING cycle={index}")
        await send_pcm(base.replace("http", "ws") + "/ws/esp32", index)
        pending = await asyncio.to_thread(wait_for_preview, base, previous_id)
        previous_id = pending["pending_id"]
        print(f"[STATE] PREVIEW cycle={index} pending_id={previous_id}")
        response = requests.post(f"{base}/api/dataset/accept", json={
            "pending_id": previous_id, "category": "positive_marvin",
            "speaker_id": "speaker_repeat_test", "session_id": "session_repeat_test",
            "prompt": "MARVIN", "label": "marvin", "environment": "generated_test",
            "distance": "n/a", "speaking_style": "test_tone",
        }, timeout=10)
        response.raise_for_status()
        result = response.json()
        assert result["success"] is True
        assert result["collector_state"] == "READY"
        assert result["dataset"]["counts"]["positive_marvin"] == index
        print(f"[SAVE] success cycle={index} sample_id={result['sample_id']} filename={result['filename']}")
        print(f"[STATE] READY cycle={index} count={index}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8012")
    parser.add_argument("--cycles", type=int, default=10)
    args = parser.parse_args()
    asyncio.run(main(args.base, args.cycles))
