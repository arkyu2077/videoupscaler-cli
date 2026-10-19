# videoupscaler CLI: https://videoupscaler.co/docs
#   docker run --rm -e VIDEOUPSCALER_API_KEY videoupscaler/cli account
FROM python:3.12-slim

LABEL org.opencontainers.image.title="videoupscaler" \
      org.opencontainers.image.description="Command-line client for the VideoUpscaler API: upscale videos to 1080p, 2K or 4K with AI." \
      org.opencontainers.image.url="https://videoupscaler.co" \
      org.opencontainers.image.documentation="https://videoupscaler.co/docs" \
      org.opencontainers.image.source="https://github.com/arkyu2077/videoupscaler-cli" \
      org.opencontainers.image.licenses="MIT"

COPY pyproject.toml README.md LICENSE /src/
COPY src /src/src
RUN pip install --no-cache-dir /src && rm -rf /src /root/.cache

# Mount a folder here to upscale local files and keep results:
#   docker run --rm -e VIDEOUPSCALER_API_KEY -v "$PWD:/work" videoupscaler/cli upscale clip.mp4 --out result.mp4
WORKDIR /work
ENTRYPOINT ["videoupscaler"]
CMD ["--help"]
