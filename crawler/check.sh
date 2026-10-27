#!/bin/sh
# Every check, the same ones CI runs; all have to pass before a commit.
set -e
cd "$(dirname "$0")"
uv sync --locked
uv run ruff format --check .
uv run ruff check .
uv run pyright
uv run pytest
