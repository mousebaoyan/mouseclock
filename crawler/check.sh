#!/bin/sh
# Every check, the same ones CI runs; all have to pass before a commit.
set -e
cd "$(dirname "$0")"
uv sync --locked
# The website's API types are generated from its OpenAPI document and must match it.
uv run datamodel-codegen --check
uv run ruff format --check .
uv run ruff check .
uv run pyright
uv run pytest
