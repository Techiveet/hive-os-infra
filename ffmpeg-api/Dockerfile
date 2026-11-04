FROM python:3.12-slim

ARG DEBIAN_FRONTEND=noninteractive

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore

# Install FFmpeg (full build with all codecs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install media and computer-vision dependencies. OpenCV is kept headless so
# the service stays small and does not pull desktop GUI libraries.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --retries 10 --timeout 120 \
    flask \
    gunicorn \
    "numpy>=2.0,<3" \
    "opencv-python-headless>=4.10,<5"

RUN groupadd --system --gid 10001 hive-media \
    && useradd --system --uid 10001 --gid hive-media --create-home hive-media

WORKDIR /app
COPY --chown=hive-media:hive-media server.py .

USER hive-media

EXPOSE 9090

CMD ["gunicorn", "--bind", "0.0.0.0:9090", "--timeout", "600", "--workers", "2", "--no-control-socket", "server:app"]
