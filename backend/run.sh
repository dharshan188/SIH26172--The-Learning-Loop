#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi
backend_port="${MARVIN_SERVER_PORT:-8011}"
exec .venv/bin/uvicorn app:app --host 0.0.0.0 --port "$backend_port"
