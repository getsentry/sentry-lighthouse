# syntax=docker/dockerfile:1.7
#
# sentry-lhci runtime image. One stage; no compile step (plain JS).
#
# Build:
#   docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t sentry-lhci .
#
# Run:
#   docker run --rm -p 8080:8080 -v $(pwd)/data:/data --env-file .env sentry-lhci

FROM node:22.22.2-bookworm-slim

# Chrome runtime deps. We use Playwright's bundled Chromium (pinned, reproducible)
# rather than `apt install chromium` (floats with Debian updates).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
      libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 libxdamage1 \
      libxfixes3 libxkbcommon0 libxrandr2 libxss1 libxtst6 \
      tar gzip curl \
    && rm -rf /var/lib/apt/lists/*

# pnpm so SSR test apps that ship a pnpm lockfile can be served as-is.
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

# Install dependencies first for layer caching.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Pre-fetch the Chromium binary into the image. Playwright stores it under
# /root/.cache/ms-playwright by default; we keep that for parity with local
# dev. We install only the binary — system deps are already in the base
# layer above (the apt-get above is the same set `playwright install --with-deps`
# would install).
RUN npx --yes playwright install chromium

# Application code (Dockerfile is the only thing that needs no rebuild on src
# changes; everything else gets COPYed here).
COPY src ./src
COPY views ./views

# Versioning: GIT_SHA is baked in at build time and read by /healthz.
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

VOLUME /data
EXPOSE 8080

# Supervisor spawns the server and the publisher as siblings, forwarding
# signals and exiting when either child exits (Northflank then restarts the
# whole container). Both children run migrations on boot (idempotent).
CMD ["node", "src/supervisor.js"]
