import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';
import { warmDevPreview } from './warm-dev-preview.mjs';

const require = createRequire(import.meta.url);
const port = Number(process.env.PORT ?? 3000);
const shutdown = new AbortController();
const server = spawn(
  process.execPath,
  [
    require.resolve('next/dist/bin/next'),
    'dev',
    '--turbopack',
    '--port',
    String(port),
  ],
  { stdio: 'inherit' },
);

function stop(signal) {
  shutdown.abort();
  server.kill(signal);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('error', () => {
  shutdown.abort();
  console.error('[dev-preview] Failed to start Next.js');
  process.exitCode = 1;
});
server.on('close', (code, signal) => {
  shutdown.abort();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});

void warmDevPreview({ port, signal: shutdown.signal }).then(
  ({ durationMs }) =>
    console.log(`[dev-preview] Authenticated home ready in ${durationMs}ms`),
  () => {
    if (!shutdown.signal.aborted) {
      console.warn(
        '[dev-preview] Authenticated home warmup failed; the dev server is still running',
      );
    }
  },
);
