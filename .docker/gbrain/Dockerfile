# Brain: deployment-hosted gbrain (https://github.com/garrytan/gbrain).
#
# Pinned by commit; upgrade deliberately on upstream release waves, never by
# tracking master. Install comes from the GitHub repo, NOT npm: an unrelated
# npm package shadows the name.
#
# Postgres + pgvector backs both the HTTP server and gbrain's durable job
# worker. The worker is required for Roomote-scheduled maintenance cycles.
FROM oven/bun:1.3.14

ARG GBRAIN_REF=d995508731ac85710c05486536a5458a00c37d73

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git postgresql-client \
  && rm -rf /var/lib/apt/lists/*

RUN bun install -g "github:garrytan/gbrain#${GBRAIN_REF}"

# bun hoists global deps, but gbrain resolves its PGLite wasm assets relative
# to its own node_modules (spike gotcha 1). Link the hoisted package where
# gbrain expects it; keep this until fixed upstream.
RUN set -e; \
  GBRAIN_DIR="/root/.bun/install/global/node_modules/gbrain"; \
  ELECTRIC_DIR="/root/.bun/install/global/node_modules/@electric-sql"; \
  if [ -d "$GBRAIN_DIR" ] && [ -d "$ELECTRIC_DIR" ]; then \
    mkdir -p "$GBRAIN_DIR/node_modules"; \
    ln -sfn "$ELECTRIC_DIR" "$GBRAIN_DIR/node_modules/@electric-sql"; \
  fi

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Generated tokens, local service config, and the Markdown corpus live on the
# volume. Postgres remains gbrain's query index and durable job backend.
VOLUME /data
ENV GBRAIN_DATA_DIR=/data

EXPOSE 8931

ENTRYPOINT ["/entrypoint.sh"]
