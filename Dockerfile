# videoupscaler CLI: https://videoupscaler.co/docs
#   docker run --rm -e VIDEOUPSCALER_API_KEY ghcr.io/arkyu2077/videoupscaler account
FROM python:3.12-slim

LABEL org.opencontainers.image.title="videoupscaler" \
      org.opencontainers.image.description="Official CLI & SDK for VideoUpscaler (https://videoupscaler.co) — AI video upscaling to 1080p, 2K, and 4K" \
      org.opencontainers.image.url="https://videoupscaler.co" \
      org.opencontainers.image.documentation="https://videoupscaler.co/docs/workflows" \
      org.opencontainers.image.source="https://github.com/arkyu2077/videoupscaler-cli" \
      org.opencontainers.image.licenses="MIT"

COPY pyproject.toml README.md LICENSE /src/
COPY src /src/src
RUN pip install --no-cache-dir /src && rm -rf /src /root/.cache

# Mount a folder here to upscale local files and keep results:
#   docker run --rm -e VIDEOUPSCALER_API_KEY -v "$PWD:/work" ghcr.io/arkyu2077/videoupscaler upscale clip.mp4 --out result.mp4
WORKDIR /work
ENTRYPOINT ["videoupscaler"]
CMD ["--help"]
