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

RUN useradd --create-home --uid 10001 judgment \
  && mkdir -p /models && chown judgment /models
USER judgment
WORKDIR /app
COPY --chown=judgment server.py .

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4)"
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
