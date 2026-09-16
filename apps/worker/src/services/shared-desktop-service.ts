import { SHARED_DESKTOP_NAMED_PORT } from '@roomote/types';
import { access } from 'node:fs/promises';

import { CommandExecutor } from '../command-executor';

const SHARED_DESKTOP_BINARY = '/usr/local/bin/roomote-desktop-stream';
const HEALTH_CHECK_ATTEMPTS = 30;

export async function startSharedDesktop(params: {
  cwd: string;
  env: Record<string, string | undefined>;
}): Promise<boolean> {
  try {
    await access(SHARED_DESKTOP_BINARY);
  } catch {
    console.warn(
      'Shared Desktop is unavailable because this worker image predates the streaming service',
    );
    return false;
  }
  params.env.DISPLAY ??= ':99';
  params.env.PULSE_SINK ??= 'roomote_stream';
  params.env.ROOMOTE_DESKTOP_STREAM_DISPLAY ??= params.env.DISPLAY;
  params.env.ROOMOTE_DESKTOP_STREAM_AUDIO_MODE ??= 'pulse';
  params.env.ROOMOTE_DESKTOP_STREAM_PULSE_SOURCE ??= 'roomote_stream.monitor';
  params.env.ROOMOTE_DESKTOP_STREAM_PORT ??= String(
    SHARED_DESKTOP_NAMED_PORT.port,
  );

  const executor = new CommandExecutor(params.cwd, params.env, false, {
    detachedProcessManager: 'pm2',
  });
  await executor.execute({
    name: 'Start Shared Desktop',
    run: `
set -euo pipefail
display_number="\${DISPLAY#:}"
display_number="\${display_number%%.*}"
xvfb_pid=""
cleanup() {
  if [ -n "$xvfb_pid" ]; then
    kill "$xvfb_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM
if [ ! -S "/tmp/.X11-unix/X$display_number" ]; then
  Xvfb "$DISPLAY" -screen 0 "\${ROOMOTE_DESKTOP_STREAM_WIDTH:-1920}x\${ROOMOTE_DESKTOP_STREAM_HEIGHT:-1080}x24" -nolisten tcp &
  xvfb_pid="$!"
fi
pulseaudio --start --exit-idle-time=-1
if ! pactl list short sinks | grep -q '[[:space:]]roomote_stream[[:space:]]'; then
  pactl load-module module-null-sink sink_name=roomote_stream >/dev/null
fi
exec ${SHARED_DESKTOP_BINARY}
`.trim(),
    detached: true,
    timeout: 30,
    continue_on_error: false,
  });

  for (let attempt = 0; attempt < HEALTH_CHECK_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${SHARED_DESKTOP_NAMED_PORT.port}/healthz`,
      );
      if (response.ok) return true;
    } catch {
      // Service startup is asynchronous under PM2.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error('Shared Desktop failed to become healthy');
}
