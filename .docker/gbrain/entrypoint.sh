#!/bin/sh
# Brain bootstrap: init-once, then run the HTTP server and durable job worker.
#
# Credential provisioning happens over gbrain's admin HTTP API at connect
# time (Roomote registers its own scoped OAuth clients), so nothing is
# pre-minted here. The admin bootstrap token comes from
# GBRAIN_ADMIN_BOOTSTRAP_TOKEN (>= 32 chars of [A-Za-z0-9_-]; gbrain
# validates at startup). When unset, one is generated on first boot and
# persisted on the volume so restarts keep the same token; the operator
# reads it from $DATA_DIR/admin-bootstrap-token when connecting.
set -eu

DATA_DIR="${GBRAIN_DATA_DIR:-/data}"
BRAIN_DIR="$DATA_DIR/brain"
TOKEN_FILE="$DATA_DIR/admin-bootstrap-token"
CONFIG_FILE="$DATA_DIR/.gbrain/config.json"
STORAGE_LAYOUT_FILE="$DATA_DIR/roomote-brain-storage-layout"
STORAGE_LAYOUT_VERSION="filesystem-v1"
STORAGE_LAYOUT_RESETTING="${STORAGE_LAYOUT_VERSION}-resetting"
PORT="${GBRAIN_PORT:-8931}"
# Width of the vector column, fixed when the brain is created. Defaults to
# text-embedding-3-small, which is what both providers serve by default.
# Overriding it means overriding the embedding model to match: a column sized
# for one model and filled by another is the failure gbrain's own PR #1421
# incident describes.
EMBEDDING_DIMENSIONS="${GBRAIN_EMBEDDING_DIMENSIONS:-1536}"

mkdir -p "$DATA_DIR"

write_storage_layout() {
  layout="$1"
  temporary_layout_file="${STORAGE_LAYOUT_FILE}.tmp"
  printf '%s\n' "$layout" > "$temporary_layout_file"
  mv -f "$temporary_layout_file" "$STORAGE_LAYOUT_FILE"
}

# gbrain keeps its registration in $HOME/.gbrain, not in the data dir.
# Anchor HOME on the volume so a rebuilt container still knows its brain.
export HOME="$DATA_DIR"

# Hosted deployments reuse their existing Postgres service while keeping the
# Brain in its own database. gbrain installs database-wide maintenance and RLS
# machinery in public, so pointing it at Roomote's application database would
# let its migrations affect application tables. Creating a sibling database
# gives it an independent public schema without another Railway service.
if [ -z "${GBRAIN_DATABASE_URL:-}" ]; then
  echo "[gbrain-entrypoint] GBRAIN_DATABASE_URL is required (gbrain maintenance needs Postgres)" >&2
  exit 2
fi

GBRAIN_DATABASE_NAME="${GBRAIN_DATABASE_NAME:-gbrain}"
case "$GBRAIN_DATABASE_NAME" in
  *[!A-Za-z0-9_]* | '')
    echo "[gbrain-entrypoint] GBRAIN_DATABASE_NAME must contain only letters, numbers, and underscores" >&2
    exit 2
    ;;
esac

DATABASE_SEED_URL="${GBRAIN_DATABASE_BOOTSTRAP_URL:-$GBRAIN_DATABASE_URL}"
if [ -n "${GBRAIN_DATABASE_BOOTSTRAP_URL:-}" ]; then
  DATABASE_BOOTSTRAP_URL="$GBRAIN_DATABASE_BOOTSTRAP_URL"
else
  DATABASE_BOOTSTRAP_URL="$(DATABASE_BOOTSTRAP_URL="$DATABASE_SEED_URL" \
    bun -e '
      const url = new URL(Bun.env.DATABASE_BOOTSTRAP_URL);
      url.pathname = "/postgres";
      console.log(url.toString());
    ')"
fi

GBRAIN_DATABASE_URL="$(DATABASE_SEED_URL="$DATABASE_SEED_URL" \
  GBRAIN_DATABASE_NAME="$GBRAIN_DATABASE_NAME" \
  bun -e '
    const url = new URL(Bun.env.DATABASE_SEED_URL);
    url.pathname = `/${Bun.env.GBRAIN_DATABASE_NAME}`;
    console.log(url.toString());
  ')"
export GBRAIN_DATABASE_URL

CURRENT_STORAGE_LAYOUT="$(cat "$STORAGE_LAYOUT_FILE" 2>/dev/null || true)"

if [ "$CURRENT_STORAGE_LAYOUT" != "$STORAGE_LAYOUT_VERSION" ]; then
  echo "[gbrain-entrypoint] initializing filesystem-backed Brain (existing Brain content will be rebuilt)"
  # Only the reset itself may repeat after an interruption. Once it completes,
  # persist the final layout before gbrain init and the remaining config steps,
  # so a later bootstrap failure resumes instead of dropping the fresh Brain.
  if [ "$CURRENT_STORAGE_LAYOUT" != "$STORAGE_LAYOUT_RESETTING" ]; then
    write_storage_layout "$STORAGE_LAYOUT_RESETTING"
  fi
  psql --dbname="$DATABASE_BOOTSTRAP_URL" --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
    -v brain_database="$GBRAIN_DATABASE_NAME" <<'SQL'
SELECT pg_advisory_lock(hashtext('roomote-gbrain-database-bootstrap')) AS locked \gset
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = :'brain_database' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'brain_database') \gexec
SELECT format('CREATE DATABASE %I', :'brain_database') \gexec
SELECT pg_advisory_unlock(hashtext('roomote-gbrain-database-bootstrap')) AS unlocked \gset
SQL

  # The target is fixed under DATA_DIR. Keep deployment credentials alongside
  # it, but remove the old corpus/config so gbrain cannot mix storage layouts.
  rm -rf "$BRAIN_DIR"
  rm -f "$CONFIG_FILE"
  write_storage_layout "$STORAGE_LAYOUT_VERSION"
else
  echo "[gbrain-entrypoint] ensuring isolated Postgres database $GBRAIN_DATABASE_NAME"
  psql --dbname="$DATABASE_BOOTSTRAP_URL" --no-psqlrc --quiet -v ON_ERROR_STOP=1 \
    -v brain_database="$GBRAIN_DATABASE_NAME" <<'SQL'
SELECT pg_advisory_lock(hashtext('roomote-gbrain-database-bootstrap')) AS locked \gset
SELECT format('CREATE DATABASE %I', :'brain_database')
WHERE NOT EXISTS (
  SELECT FROM pg_database WHERE datname = :'brain_database'
) \gexec
SELECT pg_advisory_unlock(hashtext('roomote-gbrain-database-bootstrap')) AS unlocked \gset
SQL
fi

if [ -z "${GBRAIN_ADMIN_BOOTSTRAP_TOKEN:-}" ]; then
  if [ ! -s "$TOKEN_FILE" ]; then
    echo "[gbrain-entrypoint] generating admin bootstrap token at $TOKEN_FILE"
    head -c 48 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=' | cut -c1-48 > "$TOKEN_FILE"
    # Readable by the app services: they run as a non-root user from another
    # image and mount this volume read-only, so owner-only permissions leave
    # them unable to read what the file exists to give them. The volume is
    # only ever mounted into this deployment's own containers.
    chmod 644 "$TOKEN_FILE"
  fi
  GBRAIN_ADMIN_BOOTSTRAP_TOKEN="$(cat "$TOKEN_FILE")"
  export GBRAIN_ADMIN_BOOTSTRAP_TOKEN
  echo "[gbrain-entrypoint] admin bootstrap token available at $TOKEN_FILE (not logged)"
fi

# Gateway mode: the Brain calls Roomote instead of a provider directly, so it
# never holds a provider key and an admin can change that key in Settings
# without restarting anything here. Some hosts (Render) cannot build a URL
# from a service reference, so they pass the api host alone and the origin is
# composed here, the same way the app image derives TRPC_URL and S3_ENDPOINT.
if [ -z "${OPENAI_BASE_URL:-}" ] && [ -n "${ROOMOTE_API_HOST:-}" ]; then
  OPENAI_BASE_URL="https://${ROOMOTE_API_HOST}/api/brain/inference"
  export OPENAI_BASE_URL
fi

# Compose stacks brought up by hand supply no gateway token, so generate one
# on the volume the app services already mount read-only. Same treatment as
# the admin bootstrap token above: nobody has to invent a value, and no shared
# default ships in the repository.
GATEWAY_TOKEN_FILE="$DATA_DIR/gateway-token"

if [ -z "${OPENAI_API_KEY:-}" ] && [ -n "${OPENAI_BASE_URL:-}" ]; then
  if [ ! -s "$GATEWAY_TOKEN_FILE" ]; then
    echo "[gbrain-entrypoint] generating gateway token at $GATEWAY_TOKEN_FILE"
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$GATEWAY_TOKEN_FILE"
    chmod 644 "$GATEWAY_TOKEN_FILE"
  fi

  OPENAI_API_KEY="$(cat "$GATEWAY_TOKEN_FILE")"
  export OPENAI_API_KEY
fi

# Model defaults follow whichever provider credential is present, so every
# deployment surface (compose, Railway, Coolify, Render) passes keys through
# and none of them has to encode a provider-conditional default of its own.
# Both providers serve the same OpenAI models; the prefix only decides who
# routes and bills for them. OpenRouter wins when both keys are set: it is the
# pre-existing default, and an operator adding an OpenAI key for some other
# purpose should never silently re-point a populated Brain's embeddings.
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  BRAIN_PROVIDER="openrouter"
  DEFAULT_EMBEDDING_MODEL="openrouter:openai/text-embedding-3-small"
  DEFAULT_CHAT_MODEL="openrouter:openai/gpt-5.6-luna"
elif [ -n "${OPENAI_API_KEY:-}" ]; then
  BRAIN_PROVIDER="openai"
  DEFAULT_EMBEDDING_MODEL="openai:text-embedding-3-small"
  DEFAULT_CHAT_MODEL="openai:gpt-5.6-luna"
else
  # No credential: the server still boots and serves, it just cannot embed or
  # synthesize. Roomote gates every Brain code path on the same keys, so it
  # will not talk to this container either.
  BRAIN_PROVIDER="none"
  DEFAULT_EMBEDDING_MODEL=""
  DEFAULT_CHAT_MODEL=""
fi

# An operator-chosen embedding model arrives as a bare id (text-embedding-3-large)
# because it is written once and must survive a provider switch; gbrain wants
# it provider-qualified. Qualify it with whichever provider this container
# talks to, which in gateway mode is always openai, since Roomote translates
# the name on the way out.
if [ -n "${GBRAIN_EMBEDDING_MODEL:-}" ] && [ "$BRAIN_PROVIDER" != "none" ]; then
  case "$GBRAIN_EMBEDDING_MODEL" in
    *:*) ;;
    *)
      GBRAIN_EMBEDDING_MODEL="${BRAIN_PROVIDER}:${GBRAIN_EMBEDDING_MODEL}"
      export GBRAIN_EMBEDDING_MODEL
      ;;
  esac
fi

DEFAULT_EMBEDDING_MODEL="${GBRAIN_EMBEDDING_MODEL:-$DEFAULT_EMBEDDING_MODEL}"
unset GBRAIN_EMBEDDING_MODEL

# The resolved embedding model is used for init below and nothing else. It is
# never left in the environment for gbrain to read per request, because env
# wins over config there and gbrain documents an incident (its PR #1421) where
# exactly that split kept producing 1536d vectors after a schema moved to
# 2560d. The chat model has no such coupling, so it is a plain export.
if [ -z "${GBRAIN_MODEL:-}" ] && [ -n "$DEFAULT_CHAT_MODEL" ]; then
  GBRAIN_MODEL="$DEFAULT_CHAT_MODEL"
  export GBRAIN_MODEL
fi

# Gateway mode with nothing to present is a misconfiguration that otherwise
# fails quietly: the brain initializes without embedding, ingestion still
# writes pages, and retrieval silently degrades to keyword-only. Say it at
# every start, since the operator's next action fixes it.
if [ -n "${OPENAI_BASE_URL:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "[gbrain-entrypoint] WARNING: this Brain is pointed at ${OPENAI_BASE_URL} but has no gateway token."
  echo "[gbrain-entrypoint] WARNING: set R_BRAIN_GATEWAY_TOKEN (any 32+ random characters) and restart."
  echo "[gbrain-entrypoint] WARNING: until then it cannot embed, and recall is keyword-only."
fi

if [ -n "${OPENAI_BASE_URL:-}" ] && [ "$BRAIN_PROVIDER" = "openai" ]; then
  echo "[gbrain-entrypoint] provider: roomote gateway (${OPENAI_BASE_URL})"
else
  echo "[gbrain-entrypoint] provider: $BRAIN_PROVIDER (direct)"
fi

# Init runs after provider resolution because the embedding model is a
# create-time decision, not a runtime one: it sizes the vector column, and
# gbrain refuses to change it afterwards on a populated brain. Initializing
# with --no-embedding writes a permanent `embedding_disabled: true` sentinel
# that blocks every embed callsite, which silently degrades retrieval to
# lexical-only no matter what model variables are set later.
if grep -q '"engine": *"pglite"' "$CONFIG_FILE" 2>/dev/null; then
  echo "[gbrain-entrypoint] replacing the legacy PGLite brain with Postgres"
  rm -rf "$BRAIN_DIR"
  rm -f "$CONFIG_FILE"
fi

if [ ! -s "$CONFIG_FILE" ]; then
  if [ "$BRAIN_PROVIDER" = "none" ]; then
    echo "[gbrain-entrypoint] initializing brain (Postgres, no provider key: embedding deferred)"
    gbrain init --no-embedding --non-interactive
  else
    echo "[gbrain-entrypoint] initializing brain (Postgres, embedding: $DEFAULT_EMBEDDING_MODEL)"
    # --skip-embed-check: the key is not exercised at init time, so a brain
    # still comes up on a temporarily unreachable provider instead of leaving
    # the volume half-initialized.
    gbrain init \
      --embedding-model "$DEFAULT_EMBEDDING_MODEL" \
      --embedding-dimensions "$EMBEDDING_DIMENSIONS" \
      --skip-embed-check \
      --non-interactive \
      --path "$BRAIN_DIR"
  fi
fi

# Roomote's collectors write through gbrain's MCP API. Pointing the default
# source at a real directory makes every successful put_page also render a
# Markdown artifact there. Roomote performs one bounded, cited daily digest
# through its provider-neutral gateway; native dream reflection/pattern pages
# remain disabled because they do not refresh existing entity prose. That
# missing supported capability is tracked upstream:
# https://github.com/garrytan/gbrain/issues/4294
mkdir -p "$BRAIN_DIR"
gbrain config set sync.repo_path "$BRAIN_DIR" >/dev/null
gbrain config set dream.synthesize.session_corpus_dir "$BRAIN_DIR" >/dev/null
gbrain config set dream.synthesize.enabled false >/dev/null
gbrain config set dream.patterns.enabled false >/dev/null
# Pin the latest native synthesis contract even while the phase is disabled,
# so enabling it later uses one bounded validated completion rather than the
# legacy multi-turn child loop.
gbrain config set dream.synthesize.mode oneshot >/dev/null
gbrain config set dream.synthesize.link_manifest true >/dev/null
# Roomote routes synthesis through an OpenAI-compatible gateway. gbrain's
# legacy subagent loop only supports Anthropic directly, so non-Anthropic
# models need the provider-neutral gateway loop or every dream child is
# rejected before inference.
gbrain config set agent.use_gateway_loop true >/dev/null
echo "[gbrain-entrypoint] corpus checkout: $BRAIN_DIR (filesystem + Postgres index)"

# Route gbrain's OpenRouter reranker through the same Roomote credential
# gateway as embeddings and chat. Do this after initialization so exposing an
# OpenRouter-compatible endpoint does not change which provider gbrain chooses
# when it creates the Brain. An empty forwarded setting restores the default,
# including after a deployment previously selected another reranker.
GBRAIN_RERANKER_MODEL="${GBRAIN_RERANKER_MODEL:-openrouter:voyageai/rerank-2.5-lite}"
case "$GBRAIN_RERANKER_MODEL" in
  openrouter:*)
    if [ -z "${OPENROUTER_BASE_URL:-}" ] && [ -n "${OPENAI_BASE_URL:-}" ]; then
      OPENROUTER_BASE_URL="${OPENAI_BASE_URL%/}"
      case "$OPENROUTER_BASE_URL" in
        */v1) ;;
        *) OPENROUTER_BASE_URL="$OPENROUTER_BASE_URL/v1" ;;
      esac
      export OPENROUTER_BASE_URL
    fi
    if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -n "${OPENAI_API_KEY:-}" ]; then
      OPENROUTER_API_KEY="$OPENAI_API_KEY"
      export OPENROUTER_API_KEY
    fi
    if [ -z "${OPENROUTER_BASE_URL:-}" ] || [ -z "${OPENROUTER_API_KEY:-}" ]; then
      echo "[gbrain-entrypoint] WARNING: $GBRAIN_RERANKER_MODEL needs OPENROUTER_BASE_URL and OPENROUTER_API_KEY."
      echo "[gbrain-entrypoint] WARNING: reranking will remain fail-open until the gateway is configured."
    fi
    ;;
esac

gbrain config set search.reranker.model "$GBRAIN_RERANKER_MODEL" >/dev/null
echo "[gbrain-entrypoint] reranker: $GBRAIN_RERANKER_MODEL"

# Adding a key to a brain created without one is a first-class flow rather
# than an edge case: on hosts whose compose parser ignores `profiles` the
# service always runs, so a keyless first deploy followed by filling the key
# in is the normal path. That brain still carries the deferred sentinel, so
# repair it here instead of leaving retrieval quietly lexical-only.
#
# Safe to do unattended, which is why it is not gated behind a prompt: the
# migration's only destructive act is rebuilding the embedding column, and a
# deferred brain has no embeddings to lose (gbrain reports "0 chunk(s)
# invalidated"). Page content is preserved either way, and Roomote refuses to
# ingest into a keyless brain at all, so there is rarely anything here yet.
#
# The middle step keeps the repair compatible with brains initialized by
# older gbrain releases whose `config set embedding_disabled false` command
# did not persist the change. The file edit is idempotent on newer releases.
if [ "$BRAIN_PROVIDER" != "none" ] &&
  grep -q '"embedding_disabled": *true' "$CONFIG_FILE" 2>/dev/null; then
  echo "[gbrain-entrypoint] this brain predates its provider key; enabling semantic recall"

  # Deliberately not chained on the migration's exit code: on a deferred brain
  # it rebuilds the vector column (the part that matters here) and then exits
  # non-zero when its own re-embed pass trips the very sentinel being cleared
  # two lines down. `embed --all` is the real success signal.
  gbrain migrate embeddings --to "$DEFAULT_EMBEDDING_MODEL" --yes >/dev/null 2>&1 || true

  if bun -e "
      const p = '$CONFIG_FILE';
      const c = JSON.parse(await Bun.file(p).text());
      delete c.embedding_disabled;
      await Bun.write(p, JSON.stringify(c, null, 2));
    " &&
    gbrain embed --all >/dev/null 2>&1; then
    echo "[gbrain-entrypoint] semantic recall enabled ($DEFAULT_EMBEDDING_MODEL, ${EMBEDDING_DIMENSIONS}d)"
  else
    echo "[gbrain-entrypoint] WARNING: could not enable embeddings automatically."
    echo "[gbrain-entrypoint] WARNING: retrieval stays lexical-only. Stop this service and run:"
    echo "[gbrain-entrypoint] WARNING:   gbrain migrate embeddings --to $DEFAULT_EMBEDDING_MODEL --yes"
    echo "[gbrain-entrypoint] WARNING:   (remove the \"embedding_disabled\" key from $CONFIG_FILE)"
    echo "[gbrain-entrypoint] WARNING:   gbrain embed --all"
  fi
fi

# The vector column cannot be resized in place, so a dimension change after
# creation is a silent corruption risk rather than a config change. Say so on
# the start that introduces it, while the operator still has the context to
# act, instead of letting embeds fail or store mismatched vectors later.
CONFIGURED_DIMENSIONS="$(sed -n 's/.*"embedding_dimensions": *\([0-9]*\).*/\1/p' "$CONFIG_FILE" 2>/dev/null | head -1)"

if [ -n "$CONFIGURED_DIMENSIONS" ] && [ "$CONFIGURED_DIMENSIONS" != "$EMBEDDING_DIMENSIONS" ]; then
  echo "[gbrain-entrypoint] WARNING: this brain's vector column is ${CONFIGURED_DIMENSIONS}d but ${EMBEDDING_DIMENSIONS}d is configured."
  echo "[gbrain-entrypoint] WARNING: the column keeps its original width; the setting is ignored."
  echo "[gbrain-entrypoint] WARNING: to change it, stop this service and run:"
  echo "[gbrain-entrypoint] WARNING:   gbrain migrate embeddings --to <provider:model> --yes"
fi

echo "[gbrain-entrypoint] starting durable job worker"
rm -f "$DATA_DIR/gbrain-worker-supervisor.pid"
gbrain jobs supervisor \
  --concurrency "${GBRAIN_WORKER_CONCURRENCY:-1}" \
  --pid-file "$DATA_DIR/gbrain-worker-supervisor.pid" &
WORKER_PID=$!

echo "[gbrain-entrypoint] starting gbrain serve on :$PORT (full surface)"
# gbrain binds loopback by default, which no container network can reach.
# 0.0.0.0 covers Docker/compose; platforms whose private network is IPv6-only
# (Railway) set GBRAIN_BIND=:: so the service is reachable there.
gbrain serve --http --port "$PORT" --bind "${GBRAIN_BIND:-0.0.0.0}" --surface full &
SERVER_PID=$!

# The brain repo's git mirror (gbrain's durability hardening: a post-commit
# auto-push plus a repo-scoped credential helper) is set up by
# `gbrain sources harden`, which reads the PAT from GBRAIN_GITHUB_PAT. It
# writes the credential file under $HOME/.gbrain. Run by hand in an ssh
# session that meant /root, which the next deploy rebuilt, and every commit
# since sat local-only (observed: 9.7k unpushed commits, three days of
# silent "LOCAL-ONLY, NEEDS ATTENTION" in the push log). Re-run it on every
# boot, under the volume-anchored HOME above, so the credential survives
# redeploys and a freshly provisioned brain is hardened as soon as the PAT
# is set. Idempotent by design, DB-backed (needs the server's registry, so
# it runs after startup), and never fatal.
if [ -n "${GBRAIN_GITHUB_PAT:-}" ]; then
  (
    sleep 30
    echo "[gbrain-entrypoint] hardening the brain repo mirror (GBRAIN_GITHUB_PAT is set)"
    gbrain sources harden --all --no-cron 2>&1 \
      | sed 's/^/[gbrain-entrypoint] mirror: /' || true
  ) &
  HARDEN_PID=$!
else
  HARDEN_PID=""
fi

# Hot-memory facts that gbrain's own put_page backstop extracts land in the
# database without a markdown fence (row_num NULL). The nightly extract_facts
# phase refuses to run while such rows exist for live entity pages, reading
# them as an interrupted v0.32.2 upgrade, so on any brain that is written to
# every day the phase jams permanently and consolidation starves. gbrain's
# sanctioned drain is re-running the v0.32.2 fence backfill, which is
# idempotent (only row_num IS NULL rows, de-duplicated against the page's
# existing fence), so run it at boot and once a day ahead of Roomote's
# 07:00 UTC maintenance cycle. Targeted with --migration on purpose: a
# brain created on a recent gbrain still lists every older data
# orchestrator as pending, and a bare apply-migrations would run them all.
# Never fatal: a failed drain leaves the phase skipped, which is today's
# behavior, and the log says why.
FENCE_BACKFILL_UTC_SECONDS=$((6 * 3600 + 30 * 60))
# The backfill refuses to write into a dirty working tree (it expects a human
# to review the diff), but in a hosted brain nothing reviews: gbrain commits
# its own write-through page writes, while the pages its maintenance phases
# touch sit uncommitted until something commits them. Commit the tree on
# both sides of the drain so it can run tonight and again tomorrow. The
# identity matches gbrain's bootstrap commits; an unchanged tree is a no-op.
commit_brain_tree() {
  git -C "$BRAIN_DIR" add -A 2>/dev/null \
    && git -C "$BRAIN_DIR" -c user.name=gbrain-bootstrap \
      -c user.email=bootstrap@localhost commit -q -m "$1" 2>/dev/null \
    || true
}
fence_backfill() {
  echo "[gbrain-entrypoint] fencing unfenced facts (v0.32.2 backfill)"
  commit_brain_tree "roomote: commit maintenance-written pages before fence backfill"
  # Facts whose entity page does not exist can never be fenced, so the run
  # reports "partial" every time, and three partials wedge the ledger. The
  # retry marker clears that each night; on its own it only writes the marker.
  gbrain apply-migrations --force-retry 0.32.2 --non-interactive >/dev/null 2>&1 || true
  gbrain apply-migrations --migration 0.32.2 --non-interactive 2>&1 \
    | sed 's/^/[gbrain-entrypoint] fence-backfill: /' || true
  commit_brain_tree "roomote: fence backfill (v0.32.2)"
}
(
  # Let the server and worker settle before the first drain.
  sleep 60
  fence_backfill
  while :; do
    now="$(date -u +%s)"
    delay=$((FENCE_BACKFILL_UTC_SECONDS - now % 86400))
    if [ "$delay" -le 0 ]; then
      delay=$((delay + 86400))
    fi
    sleep "$delay"
    fence_backfill
  done
) &
FENCE_PID=$!

TERMINATING=0
stop_processes() {
  kill -TERM "$SERVER_PID" "$WORKER_PID" "$FENCE_PID" ${HARDEN_PID:+"$HARDEN_PID"} 2>/dev/null || true
}
trap 'TERMINATING=1; stop_processes' TERM INT

while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$WORKER_PID" 2>/dev/null; do
  sleep 1 &
  wait $! || true
done

stop_processes
wait "$SERVER_PID" 2>/dev/null || true
wait "$WORKER_PID" 2>/dev/null || true

if [ "$TERMINATING" -eq 1 ]; then
  exit 0
fi

echo "[gbrain-entrypoint] server or job worker exited unexpectedly" >&2
exit 1
