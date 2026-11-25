# The crawler with Chromium's headless shell, built from this directory: `docker build -t crawler .`
# Built by GitHub Actions and run as deploy/compose.yml says; see design §16.
FROM ghcr.io/astral-sh/uv:0.13.6 AS uv

# The packages and Chromium come first, rebuilt only when uv.lock, pyproject.toml or the base image
# change; the project comes last, so a release that changed only the code has one small new layer.
FROM python:3.14-slim-trixie
ARG UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_NO_DEV=1 UV_PYTHON_DOWNLOADS=0 \
    UV_PROJECT_ENVIRONMENT=/app/.venv
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /src
RUN --mount=from=uv,source=/uv,target=/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-editable
# A new volume takes its owner from the cache directory.
RUN /app/.venv/bin/playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home crawler \
    && install -d -o crawler -g crawler /home/crawler/.cache /home/crawler/.cache/mouseclock
# Built anew each time: uv's cache tells a changed project by pyproject.toml, not by the code.
RUN --mount=from=uv,source=/uv,target=/bin/uv \
    --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,target=/src \
    uv sync --locked --no-editable --reinstall-package crawler
# The pages it opens are untrusted.
USER crawler
CMD ["/app/.venv/bin/crawler"]
