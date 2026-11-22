# Build from the repository root. No API credentials are included in the image.
FROM oven/bun:1.3.14 AS build
WORKDIR /build
COPY src ./src
COPY scripts/studio-hyperframes-renderer ./scripts/studio-hyperframes-renderer
# Bundle the fixed compiler without installing the application or its provider SDKs.
RUN bun build scripts/studio-hyperframes-renderer/service.ts --target=bun --external=zod --outfile=server.js

FROM node:22-bookworm-slim
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/hyperframes
COPY --chmod=644 scripts/studio-hyperframes-renderer/runtime/package*.json ./
COPY --from=build --chmod=644 /build/server.js ./server.js
COPY --from=build --chmod=644 /build/src/assets/carousel/Inter.ttf ./Inter.ttf
# Install in one layer: avoid replicating the large browser layer on VFS Docker hosts.
# The optional secret is a public proxy CA used only while building.
RUN --mount=type=secret,id=build_ca,mode=0444 \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    apt-get update && apt-get install -y --no-install-recommends ffmpeg chromium chromium-sandbox fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci --omit=dev \
    && useradd --create-home --uid 10001 render
USER render
ENV HYPERFRAMES_CACHE_DIR=/home/render/.cache/hyperframes DO_NOT_TRACK=1 HYPERFRAMES_BROWSER_PATH=/usr/bin/chromium
ENV PORT=8080 STUDIO_REEL_RENDERER_HOST=0.0.0.0 HYPERFRAMES_FONT=/opt/hyperframes/Inter.ttf XDG_CONFIG_HOME=/tmp/chromium-config XDG_CACHE_HOME=/tmp/chromium-cache
EXPOSE 8080
CMD ["bun", "/opt/hyperframes/server.js"]
