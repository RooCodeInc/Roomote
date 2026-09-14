#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { config } from '@dotenvx/dotenvx';

export const WEB_FAST_AGENT_SHUTDOWN_REQUEST =
  'roomote:web-fast-agent-shutdown';
export const WEB_FAST_AGENT_SHUTDOWN_READY =
  'roomote:web-fast-agent-shutdown-ready';
const DEFAULT_HARD_TIMEOUT_MS = 28_000;
const NEXT_CLEANUP_RESERVE_MS = 5_000;

export function resolveWebShutdownHardTimeoutMs(env = process.env) {
  const parsed = Number(env.R_WEB_SHUTDOWN_HARD_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= NEXT_CLEANUP_RESERVE_MS
    ? parsed
    : DEFAULT_HARD_TIMEOUT_MS;
}

export function coordinateWebShutdown(child, signal, options = {}) {
  const hardTimeoutMs =
    options.hardTimeoutMs ?? resolveWebShutdownHardTimeoutMs();
  const cleanupReserveMs = Math.min(NEXT_CLEANUP_RESERVE_MS, hardTimeoutMs);
  let nextCleanupStarted = false;

  const startNextCleanup = () => {
    if (nextCleanupStarted || child.exitCode !== null) return;
    nextCleanupStarted = true;
    child.kill(signal);
  };
  const onMessage = (message) => {
    if (
      message?.type === WEB_FAST_AGENT_SHUTDOWN_READY &&
      message.signal === signal
    ) {
      startNextCleanup();
    }
  };
  child.on('message', onMessage);
  child.send?.({ type: WEB_FAST_AGENT_SHUTDOWN_REQUEST, signal });

  const handoffDeadline = setTimeout(
    startNextCleanup,
    Math.max(0, hardTimeoutMs - cleanupReserveMs),
  );
  const hardDeadline = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, hardTimeoutMs);
  handoffDeadline.unref?.();
  hardDeadline.unref?.();

  return () => {
    clearTimeout(handoffDeadline);
    clearTimeout(hardDeadline);
    child.off('message', onMessage);
  };
}

export function startWebServer({
  env = process.env,
  argv = process.argv.slice(2),
} = {}) {
  const appEnv = ['development', 'preview', 'production'].includes(
    env.R_APP_ENV?.trim().toLowerCase(),
  )
    ? env.R_APP_ENV.trim().toLowerCase()
    : 'production';
  env.R_APP_ENV = appEnv;
  const envFiles = [`.env.${appEnv}`, `../../.env.${appEnv}`].filter(
    existsSync,
  );
  config({ path: envFiles, quiet: true });

  const require = createRequire(import.meta.url);
  const child = spawn(
    process.execPath,
    [require.resolve('next/dist/bin/next'), 'start', ...argv],
    {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...env, ROOMOTE_WEB_SHUTDOWN_COORDINATED: 'true' },
    },
  );
  let cleanupCoordination;
  let shuttingDown = false;
  const handlers = new Map();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const handler = () => {
      if (shuttingDown) {
        child.kill('SIGKILL');
        return;
      }
      shuttingDown = true;
      cleanupCoordination = coordinateWebShutdown(child, signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  child.on('error', (error) => {
    console.error('[web] Failed to start Next.js:', error);
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    cleanupCoordination?.();
    for (const [name, handler] of handlers) process.off(name, handler);
    if (signal === 'SIGKILL') process.exitCode = 1;
    else if (shuttingDown) process.exitCode = signal === 'SIGINT' ? 130 : 143;
    else process.exitCode = code ?? 1;
  });
  return child;
}

if (import.meta.url === `file://${process.argv[1]}`) startWebServer();
