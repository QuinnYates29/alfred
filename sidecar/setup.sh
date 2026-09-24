#!/usr/bin/env bash
# Creates sidecar/.venv (Python 3.12) with the deps the langgraph_coder sidecar needs.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"   # repo root
command -v uv >/dev/null 2>&1 || { echo "uv is required (https://docs.astral.sh/uv/)" >&2; exit 1; }
uv venv --python 3.12 sidecar/.venv
uv pip install --python sidecar/.venv/bin/python langgraph langchain-openai
echo "ok: sidecar/.venv ready"
