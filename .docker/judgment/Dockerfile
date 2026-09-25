# Judgment sidecar: a CPU decision model for self-hosted deployments.
# See server.py. Enabled with the `judgment` compose profile.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models \
    TOKENIZERS_PARALLELISM=false

# CPU-only torch first, from PyTorch's CPU index, so the GLiNER install below
# keeps it instead of pulling the multi-gigabyte CUDA build.
RUN pip install --index-url https://download.pytorch.org/whl/cpu "torch==2.8.0" \
  && pip install "gliner2[local]==2.0.0" "fastapi==0.118.0" "uvicorn==0.37.0" protobuf sentencepiece

# /models holds the Hugging Face cache. Docker initializes an empty named
# volume mounted there from this directory, ownership included, so the
# compose volume starts out writable by this user.
RUN useradd --create-home --uid 10001 judgment \
  && mkdir -p /models && chown judgment /models
USER judgment
WORKDIR /app
COPY --chown=judgment server.py .

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s \
  CMD python -c "import os, urllib.request; host = '[::1]' if ':' in os.environ.get('JUDGMENT_BIND', '') else '127.0.0.1'; urllib.request.urlopen(f'http://{host}:8080/health', timeout=4)"
# JUDGMENT_BIND=:: listens on IPv6 too, for IPv6-only private networks (Railway).
CMD ["sh", "-c", "exec uvicorn server:app --host \"${JUDGMENT_BIND:-0.0.0.0}\" --port 8080 --workers 1"]
