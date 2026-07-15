#!/usr/bin/env node
/**
 * Path-aware pre-push gates for the Roomote monorepo.
 *
 * - Always runs monorepo oxlint (sub-second).
 * - Runs turbo check-types:fast for packages changed since PRE_PUSH_BASE
 *   (default origin/develop), including dependents (`...[base]`).
 * - Runs residual web/worker ESLint only when those surfaces (or shared
 *   lint config) changed.
 * - Runs knip only when dependency/lock/knip/config surfaces changed.
 * - Types, residual lint, and knip run in parallel after oxlint.
 *
 * Force the full historical suite with PRE_PUSH_FULL=1.
 */
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forceFull = process.env.PRE_PUSH_FULL === '1';
const baseRef = process.env.PRE_PUSH_BASE || 'origin/develop';

function runCapture(command, args) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  });
}

function ensureBaseRef() {
  try {
    runCapture('git', ['rev-parse', '--verify', baseRef]);
    return baseRef;
  } catch {
    try {
      runCapture('git', ['fetch', 'origin', 'develop', '--quiet']);
      runCapture('git', ['rev-parse', '--verify', baseRef]);
      return baseRef;
    } catch {
      console.warn(
        `[pre-push] ${baseRef} unavailable; running full lint/types/knip suite.`,
      );
      return null;
    }
  }
}

function changedFiles(resolvedBase) {
  if (!resolvedBase) return null;
  try {
    return runCapture('git', ['diff', '--name-only', `${resolvedBase}...HEAD`])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function needsResidualEslint(files) {
  if (forceFull || !files) return true;
  return files.some(
    (file) =>
      file.startsWith('apps/web/') ||
      file.startsWith('apps/worker/') ||
      file.startsWith('packages/config-eslint/') ||
      file === '.oxlintrc.json' ||
      file === 'eslint.config.mjs' ||
      file === 'apps/web/eslint.config.mjs' ||
      file === 'apps/worker/eslint.config.mjs',
  );
}

function needsKnip(files) {
  if (forceFull || !files) return true;
  return files.some(
    (file) =>
      file === 'package.json' ||
      file.endsWith('/package.json') ||
      file === 'pnpm-lock.yaml' ||
      file === 'pnpm-workspace.yaml' ||
      file === 'knip.ts' ||
      file.startsWith('packages/config-'),
  );
}

function needsTypecheck(files) {
  if (forceFull || !files) return true;
  // Non-package root-only docs/husky/script changes need no package typecheck.
  return files.some((file) => {
    if (file.startsWith('apps/') || file.startsWith('packages/')) return true;
    if (file === 'package.json' || file === 'pnpm-lock.yaml') return true;
    if (file === 'turbo.json' || file.startsWith('packages/config-typescript/'))
      return true;
    return false;
  });
}

function spawnPnpm(label, args) {
  console.log(`[pre-push] ${label}: pnpm ${args.join(' ')}`);
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
      resolve();
    });
  });
}

async function main() {
  const resolvedBase = forceFull ? null : ensureBaseRef();
  const files = forceFull ? null : changedFiles(resolvedBase);

  await spawnPnpm('oxlint', ['exec', 'oxlint', '--deny-warnings']);

  const residual = needsResidualEslint(files);
  const knip = needsKnip(files);
  const types = needsTypecheck(files);

  /** @type {Promise<void>[]} */
  const work = [];

  if (types) {
    if (resolvedBase && !forceFull) {
      work.push(
        spawnPnpm('check-types:affected', [
          'exec',
          'turbo',
          'check-types:fast',
          `--filter=...[${resolvedBase}]`,
          '--log-order',
          'grouped',
          '--output-logs',
          'new-only',
        ]),
      );
    } else {
      work.push(spawnPnpm('check-types:fast', ['check-types:fast']));
    }
  } else {
    console.log('[pre-push] skipping check-types:fast (no package/tsconfig surface changes)');
  }

  if (residual) {
    work.push(
      spawnPnpm('lint:residual', [
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
    );
  } else {
    console.log('[pre-push] skipping residual web/worker ESLint (not affected)');
  }

  if (knip) {
    work.push(spawnPnpm('knip', ['knip']));
  } else {
    console.log(
      '[pre-push] skipping knip (no dependency/config surface changes)',
    );
  }

  await Promise.all(work);
  console.log('[pre-push] ok');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
