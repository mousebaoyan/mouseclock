# The crawler with Chromium's headless shell, built from this directory: `docker build -t crawler .`
# Run it with --init, which reaps the processes Chromium leaves behind, a stop timeout long
# enough for the rounds in progress to finish, and a volume at /home/crawler/.cache/mouseclock
# that keeps the words the LLM read in attachments (design §7.4).
FROM python:3.14-slim-trixie AS build
COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_NO_DEV=1 UV_PYTHON_DOWNLOADS=0
WORKDIR /app
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-editable
COPY . .
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-editable

FROM python:3.14-slim-trixie
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app/.venv /app/.venv
RUN /app/.venv/bin/playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home crawler
# The pages it opens are untrusted.
USER crawler
# A new volume takes its owner from here.
RUN mkdir -p /home/crawler/.cache/mouseclock
CMD ["/app/.venv/bin/crawler"]
