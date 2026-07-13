# Canonical worker image for Roomote sandboxes.
# Build context: repository root.
# This image is the source of truth for Roomote's durable worker OS/tooling layer.

FROM ubuntu:24.04 AS runtime

# Connects the GHCR package to this repository and links pulled images back
# to their source.
LABEL org.opencontainers.image.source=https://github.com/RooCodeInc/Roomote

ARG AGENT_BROWSER_VERSION=0.27.0
ARG OPENCODE_CLI_VERSION=1.17.8
ARG FFMPEG_INSTALLER_VERSION=1.1.0
# @ffprobe-installer (not ffprobe-static, which ships no linux/arm64 binary
# yet still reports a path for it) so amd64 and arm64 images share one recipe.
ARG FFPROBE_INSTALLER_VERSION=2.1.2
ARG GH_VERSION=2.81.0
ARG NODE_PTY_VERSION=1.1.0
ARG PM2_VERSION=7.0.1

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    bubblewrap \
    curl \
    docker.io \
    docker-compose-v2 \
    unzip \
    jq \
    git \
    inotify-tools \
    iptables \
    gnupg \
    netcat-openbsd \
    tar \
    sudo \
    lsof \
    psmisc \
    procps \
    build-essential \
    python3 \
    locales \
    xvfb \
    fontconfig \
    fonts-noto-core \
    fonts-noto-color-emoji \
    libssl-dev \
    libreadline-dev \
    zlib1g-dev \
    libyaml-dev \
    libffi-dev \
    libasound2t64 \
    libatk1.0-0t64 \
    libatk-bridge2.0-0t64 \
    libatspi2.0-0t64 \
    libcups2t64 \
    libdbus-1-3 \
    libgbm1 \
    libgtk-3-0t64 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
  && ln -sf "$(command -v python3)" /usr/local/bin/python \
  && update-alternatives --set iptables /usr/sbin/iptables-legacy \
  && update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy \
  && docker compose version \
  && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

# Install VSCode
# Run with: `$VSCODE_BIN --no-sandbox --user-data-dir $VSCODE_USER_DATA_DIR --version`
RUN ARCH="$(dpkg --print-architecture)" \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
    | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg \
  && echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/code stable main" \
    > /etc/apt/sources.list.d/vscode.list \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends code \
  && rm -rf /var/lib/apt/lists/*

# Install gh cli
RUN ARCH="$(dpkg --print-architecture)" \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" -o /tmp/gh.tar.gz \
  && tar -xzf /tmp/gh.tar.gz -C /tmp \
  && mv "/tmp/gh_${GH_VERSION}_linux_${ARCH}/bin/gh" /usr/local/bin/ \
  && rm -rf /tmp/gh.tar.gz /tmp/gh_${GH_VERSION}_linux_*

# Install AWS CLI so managed AWS environments do not need runtime apt setup.
RUN ARCH="$(dpkg --print-architecture)" \
  && case "$ARCH" in amd64) AWS_ARCH="x86_64" ;; arm64) AWS_ARCH="aarch64" ;; *) echo "Unsupported architecture for AWS CLI: $ARCH" >&2; exit 1 ;; esac \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}.zip" -o /tmp/awscliv2.zip \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli --update \
  && rm -rf /tmp/aws /tmp/awscliv2.zip \
  && aws --version | grep -q '^aws-cli/2'

# Create user 'roomote' and grant passwordless sudo.
RUN useradd -m -s /bin/bash roomote \
  && usermod -aG sudo,docker roomote \
  && echo 'roomote ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/roomote \
  && chmod 0440 /etc/sudoers.d/roomote

RUN mkdir -p \
    /sandbox \
    /sandbox/repos \
    /sandbox/.vscode \
    /opt/mise \
    /opt/mise/cache \
    /home/roomote/.local/bin \
  && chown -R roomote:roomote /sandbox /opt/mise /home/roomote

ENV MISE_DATA_DIR=/opt/mise
ENV MISE_CACHE_DIR=/opt/mise/cache
ENV RUSTUP_HOME=/home/roomote/.rustup
ENV CARGO_HOME=/home/roomote/.cargo
# Keep Rust stable under linux/amd64 emulation during image builds.
ENV RUST_MIN_STACK=16777216
ENV PATH=/home/roomote/.local/bin:/opt/mise/shims:${PATH}
ENV AGENT_BROWSER_EXECUTABLE_PATH="/opt/agent-browser/chrome"
ENV FFMPEG_EXECUTABLE_PATH="/opt/ffmpeg/bin/ffmpeg"
ENV FFPROBE_EXECUTABLE_PATH="/opt/ffmpeg/bin/ffprobe"
ENV ROOMOTE_BAKED_OPENCODE_CLI_VERSION=${OPENCODE_CLI_VERSION}

COPY .docker/sandbox/install-browser-agent.sh /tmp/install-browser-agent.sh

# Preinstall the heaviest helper services so newer worker images can start
# them directly instead of paying multi-minute apt setup during bootstrap.
RUN mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    mysql-client \
    mysql-server-core-8.0 \
    postgresql-15 \
    postgresql-16 \
    postgresql-17 \
    redis-server \
  && rm -rf /var/lib/apt/lists/*

USER roomote
WORKDIR /home/roomote

RUN curl -fsSL https://mise.run | sh \
  && echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc

RUN mkdir -p /home/roomote/.config/mise \
  && cat > /home/roomote/.config/mise/config.toml <<EOF_MISE
[tools]
# ruby = "3.4.8"
# python = "3.14.2"
# go = "1.25.5"
node = '22.17.1'
pnpm = '10.29.3'
rust = '1.92.0'
ripgrep = '15.1.0'
uv = '0.11.8'

[settings]
experimental = true
jobs = 4
auto_install = true
ruby.compile = false
EOF_MISE

# Keep Rust in mise's install graph without asking mise to execute rustc during
# arm64-to-amd64 Docker builds; rustc currently segfaults under qemu.
# See https://github.com/rust-lang/rust/issues/147026.
RUN ~/.local/bin/mise install -y node@22.17.1 pnpm@10.29.3 ripgrep@15.1.0 uv@0.11.8 \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain 1.92.0 --no-modify-path \
  && mkdir -p "$MISE_DATA_DIR/installs/rust" \
  && printf 'rust\ncore:rust' > "$MISE_DATA_DIR/installs/rust/.mise.backend" \
  && ln -sfn "$CARGO_HOME/bin" "$MISE_DATA_DIR/installs/rust/1.92.0" \
  && ~/.local/bin/mise reshim \
  && test "$(node --version)" = "v22.17.1" \
  && test "$(pnpm --version)" = "10.29.3" \
  && test -x "$CARGO_HOME/bin/rustc" \
  && test -L "$MISE_DATA_DIR/installs/rust/1.92.0" \
  && test "$(rg --version | awk 'NR == 1 { print $2 }')" = "15.1.0" \
  && test "$(uv --version | awk 'NR == 1 { print $2 }')" = "0.11.8"

RUN UV_ROOT="$(~/.local/bin/mise where uv)" \
  && UV_BIN="$(find "$UV_ROOT" -type f -name uv -perm -111 | head -n 1)" \
  && test -x "$UV_BIN" \
  && sudo "$UV_BIN" pip install --system --break-system-packages openai

ENV SHELL=/bin/bash

RUN bash /tmp/install-browser-agent.sh \
  && sudo rm -rf /var/lib/apt/lists/*

RUN sudo mkdir -p /opt/ffmpeg/bin \
  && sudo chown -R roomote:roomote /opt/ffmpeg \
  && npm install -g \
    "@ffmpeg-installer/ffmpeg@${FFMPEG_INSTALLER_VERSION}" \
    "@ffprobe-installer/ffprobe@${FFPROBE_INSTALLER_VERSION}" \
    "pm2@${PM2_VERSION}" \
  && NPM_ROOT="$(npm root -g)" \
  && PM2_BIN="$(npm prefix -g)/bin/pm2" \
  && FFMPEG_BIN="$(node -e 'const root=process.argv[1]; const pkg=require(require.resolve("@ffmpeg-installer/ffmpeg", { paths: [root] })); process.stdout.write(pkg.path);' "$NPM_ROOT")" \
  && FFPROBE_BIN="$(node -e 'const root=process.argv[1]; const pkg=require(require.resolve("@ffprobe-installer/ffprobe", { paths: [root] })); process.stdout.write(pkg.path);' "$NPM_ROOT")" \
  && test -x "$PM2_BIN" \
  && test "$("$PM2_BIN" --version | tail -n 1)" = "${PM2_VERSION}" \
  && test -x "$FFMPEG_BIN" \
  && test -x "$FFPROBE_BIN" \
  && cp "$FFMPEG_BIN" "${FFMPEG_EXECUTABLE_PATH}" \
  && cp "$FFPROBE_BIN" "${FFPROBE_EXECUTABLE_PATH}" \
  && chmod +x "${FFMPEG_EXECUTABLE_PATH}" "${FFPROBE_EXECUTABLE_PATH}" \
  && sudo ln -sf "$PM2_BIN" /usr/local/bin/pm2 \
  && sudo ln -sf "${FFMPEG_EXECUTABLE_PATH}" /usr/local/bin/ffmpeg \
  && sudo ln -sf "${FFPROBE_EXECUTABLE_PATH}" /usr/local/bin/ffprobe \
  && ln -sf "$PM2_BIN" "$HOME/.local/bin/pm2" \
  && ln -sf "${FFMPEG_EXECUTABLE_PATH}" "$HOME/.local/bin/ffmpeg" \
  && ln -sf "${FFPROBE_EXECUTABLE_PATH}" "$HOME/.local/bin/ffprobe" \
  && printf '%s\n' "${FFMPEG_INSTALLER_VERSION}+${FFPROBE_INSTALLER_VERSION}" > /opt/ffmpeg/.installed

RUN npm install --prefix /sandbox --no-save --no-package-lock \
    "node-pty@${NODE_PTY_VERSION}" \
    "opencode-ai@${OPENCODE_CLI_VERSION}" \
  && test -x /sandbox/node_modules/.bin/opencode \
  && test "$(/sandbox/node_modules/.bin/opencode --version)" = "${OPENCODE_CLI_VERSION}"

RUN cat <<'EOF' | sudo tee /usr/local/bin/opencode > /dev/null
#!/bin/bash
exec /sandbox/node_modules/.bin/opencode "$@"
EOF

RUN sudo chmod +x /usr/local/bin/opencode \
  && mkdir -p "$HOME/.local/bin" \
  && sudo cp /usr/local/bin/opencode "$HOME/.local/bin/opencode" \
  && sudo chown roomote:roomote "$HOME/.local/bin/opencode" \
  && chmod +x "$HOME/.local/bin/opencode"

# The controller uses this image as a short-lived, NET_ADMIN-only helper to
# install metadata blackhole routes in each worker's network namespace. Keep
# iproute2 in the final layer so updating this policy does not invalidate the
# expensive language-toolchain layers above.
RUN sudo apt-get update \
  && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends iproute2 \
  && sudo rm -rf /var/lib/apt/lists/*

# Shared with WORKER_RUNTIME_SCHEMA_VERSION in @roomote/types. Local builds
# pass this explicitly; the default keeps direct/release Docker builds labeled.
ARG ROOMOTE_WORKER_RUNTIME_SCHEMA_VERSION=4
LABEL dev.roomote.worker-image.schema-version="${ROOMOTE_WORKER_RUNTIME_SCHEMA_VERSION}"

WORKDIR /sandbox
