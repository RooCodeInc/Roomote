import { SHARED_DESKTOP_NAMED_PORT } from '@roomote/types';
import { access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommandExecutor } from '../command-executor';

const SHARED_DESKTOP_BINARY = '/usr/local/bin/roomote-desktop-stream';
const SHARED_DESKTOP_USER = 'roomote';
const HEALTH_CHECK_ATTEMPTS = 30;

/**
 * Environment variables the startup script forwards when it re-executes
 * itself as the unprivileged sandbox user.
 */
const FORWARDED_ENV_VARS = [
  'DISPLAY',
  'PULSE_SINK',
  'ROOMOTE_DESKTOP_STREAM_DISPLAY',
  'ROOMOTE_DESKTOP_STREAM_AUDIO_MODE',
  'ROOMOTE_DESKTOP_STREAM_PULSE_SOURCE',
  'ROOMOTE_DESKTOP_STREAM_PORT',
  'ROOMOTE_DESKTOP_STREAM_WIDTH',
  'ROOMOTE_DESKTOP_STREAM_HEIGHT',
  'ROOMOTE_DESKTOP_STREAM_FPS',
  'ROOMOTE_DESKTOP_STREAM_VIDEO_BITRATE_KBPS',
  'ROOMOTE_DESKTOP_STREAM_AUDIO_BITRATE_KBPS',
  'ROOMOTE_DESKTOP_STREAM_MAX_CLIENTS',
  'ROOMOTE_DESKTOP_STREAM_ALLOWED_CONTROL_ORIGIN',
  'ROOMOTE_DESKTOP_STREAM_FFMPEG',
] as const;

/**
 * Shell script that starts the X server (Xvnc, or Xvfb as a fallback),
 * PulseAudio, and the streaming service.
 *
 * It is written to disk and launched as a single command because the
 * command executor splits multi-line `run` strings into one command per
 * line, which would start each line as its own detached process.
 *
 * Some compute providers run the worker as root. PulseAudio refuses to start
 * as root and Xvfb cannot create `/tmp/.X11-unix` as a regular user, so the
 * script prepares the socket directory as root and then re-executes itself as
 * the sandbox user with the relevant environment forwarded.
 */
export function buildSharedDesktopStartupScript(): string {
  // Only variables that are actually set are forwarded; the service rejects
  // empty values for optional numeric settings.
  const preservedEnv = FORWARDED_ENV_VARS.join(',');

  return `#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" = "0" ] && id -u ${SHARED_DESKTOP_USER} >/dev/null 2>&1; then
  mkdir -p /tmp/.X11-unix
  chmod 1777 /tmp/.X11-unix
  exec sudo -n -u ${SHARED_DESKTOP_USER} -H \\
    --preserve-env=${preservedEnv} \\
    bash "$0"
fi
display_number="\${DISPLAY#:}"
display_number="\${display_number%%.*}"
xvfb_pid=""
cleanup() {
  if [ -n "$xvfb_pid" ]; then
    kill "$xvfb_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM
screen_size="\${ROOMOTE_DESKTOP_STREAM_WIDTH:-1920}x\${ROOMOTE_DESKTOP_STREAM_HEIGHT:-1080}"
if [ ! -S "/tmp/.X11-unix/X$display_number" ]; then
  # Prefer TigerVNC's Xvnc as the X server: unlike Xvfb it supports RandR
  # screen resizes, which lets the desktop follow the viewer's panel size.
  # It runs purely as an X server; the RFB listener is disabled.
  if command -v Xvnc >/dev/null 2>&1; then
    Xvnc "$DISPLAY" -geometry "$screen_size" -depth 24 -SecurityTypes None -rfbport -1 -localhost -nolisten tcp &
  else
    Xvfb "$DISPLAY" -screen 0 "\${screen_size}x24" -nolisten tcp &
  fi
  xvfb_pid="$!"
fi
pulseaudio --start --exit-idle-time=-1
if ! pactl list short sinks | grep -q '[[:space:]]roomote_stream[[:space:]]'; then
  pactl load-module module-null-sink sink_name=roomote_stream >/dev/null
fi
exec ${SHARED_DESKTOP_BINARY}
`;
}

export async function startSharedDesktop(params: {
  cwd: string;
  env: Record<string, string | undefined>;
  /**
   * Browser origin allowed to open the control WebSocket. The sandbox auth
   * proxy strips its forwarded-host marker on WebSocket upgrades, so the
   * service must recognize the Roomote app origin explicitly.
   */
  allowedControlOrigin?: string;
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
  if (params.allowedControlOrigin) {
    params.env.ROOMOTE_DESKTOP_STREAM_ALLOWED_CONTROL_ORIGIN ??=
      params.allowedControlOrigin;
  }

  const scriptPath = join(tmpdir(), 'roomote-shared-desktop.sh');
  await writeFile(scriptPath, buildSharedDesktopStartupScript(), {
    mode: 0o755,
  });

  const executor = new CommandExecutor(params.cwd, params.env, false, {
    detachedProcessManager: 'pm2',
  });
  await executor.execute({
    name: 'Start Shared Desktop',
    run: `bash ${scriptPath}`,
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
