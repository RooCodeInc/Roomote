#!/usr/bin/env node
/**
 * Full pre-push suite with parallel independent gates.
 * Always runs the same checks as before; only the wall-clock order changes:
 * oxlint first (fail-fast), then residual ESLint + check-types:fast + knip together.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {Promise<void>} */
function run(label, args) {
  console.log(`[pre-push] start ${label}: pnpm ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${label} terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${label} failed with exit code ${code ?? 1}`));
        return;
      }
      console.log(`[pre-push] done ${label}`);
      resolve();
    });
  });
}

async function main() {
  // Fail fast on the cheap monorepo lint pass before spinning up heavier work.
  await run('oxlint', ['exec', 'oxlint', '--deny-warnings']);

  await Promise.all([
    run('lint:residual', [
      'exec',
      'turbo',
      'lint',
      '--filter=@roomote/web',
      '--filter=@roomote/worker',
      '--log-order',
      'grouped',
      '--output-logs',
      'new-only',
    ]),
    run('check-types:fast', ['check-types:fast']),
    run('knip', ['knip']),
  ]);

  console.log('[pre-push] ok');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
