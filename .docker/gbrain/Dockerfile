# Brain: deployment-hosted gbrain (https://github.com/garrytan/gbrain).
#
# Pinned by commit; upgrade deliberately on upstream release waves, never by
# tracking master. Install comes from the GitHub repo, NOT npm: an unrelated
# npm package shadows the name.
#
# v1 runs PGLite-on-volume (verified in the M0 spike; a single long-lived
# serve process is exactly our topology, and gbrain locks the brain to one
# process anyway). Postgres + pgvector is the at-scale upgrade path.
FROM oven/bun:1.3.14

ARG GBRAIN_REF=ac402f5

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
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

# Brain data, minted tokens, and config live on the volume.
VOLUME /data
ENV GBRAIN_DATA_DIR=/data

EXPOSE 8931

ENTRYPOINT ["/entrypoint.sh"]
