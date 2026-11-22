FROM node:22-bookworm-slim
RUN --mount=type=secret,id=build_ca,mode=0444 \
    if [ -f /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca REQUESTS_CA_BUNDLE=/run/secrets/build_ca PIP_CERT=/run/secrets/build_ca; fi; \
    apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/media-python \
    && /opt/media-python/bin/pip install --no-cache-dir 'yt-dlp[default,curl-cffi]==2026.10.26' \
    && useradd --create-home --uid 10001 media
RUN mkdir -p /opt/basic-media && chmod 755 /opt/basic-media
COPY --chmod=644 scripts/basic-media-resolver/service.py /opt/basic-media/service.py
COPY --chmod=644 scripts/basic-media-resolver/native_tiktok.py /opt/basic-media/native_tiktok.py
USER media
EXPOSE 8080
CMD ["/opt/media-python/bin/python", "/opt/basic-media/service.py"]
