import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

describe('shared Docker dotenvx entrypoint', () => {
  it('loads .env.local when present', () => {
    const repoRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-entrypoint-'),
    );
    const dockerDir = path.join(repoRoot, '.docker');
    const binDir = path.join(repoRoot, 'node_modules', '.bin');
    const sourceEntrypoint = path.resolve(
      path.dirname(__filename),
      '../../../../.docker/run-with-dotenvx.sh',
    );
    const entrypoint = path.join(dockerDir, 'run-with-dotenvx.sh');
    const dotenvx = path.join(binDir, 'dotenvx');

    fs.mkdirSync(dockerDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.copyFileSync(sourceEntrypoint, entrypoint);
    fs.chmodSync(entrypoint, 0o755);
    fs.writeFileSync(
      dotenvx,
      '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n',
      'utf8',
    );
    fs.chmodSync(dotenvx, 0o755);
    fs.writeFileSync(path.join(repoRoot, '.env.local'), 'DATABASE_URL=x\n');

    const result = spawnSync(entrypoint, ['node', 'dist/index.js'], {
      env: {
        ...process.env,
        APP_ENV: 'production',
        DATABASE_URL: 'postgres://stale/runtime-db',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      'run',
      '-o',
      '-f',
      path.join(repoRoot, '.env.local'),
      '--',
      'node',
      'dist/index.js',
    ]);
  });

  it('runs the command directly when .env.local is absent', () => {
    const repoRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-entrypoint-'),
    );
    const dockerDir = path.join(repoRoot, '.docker');
    const sourceEntrypoint = path.resolve(
      path.dirname(__filename),
      '../../../../.docker/run-with-dotenvx.sh',
    );
    const entrypoint = path.join(dockerDir, 'run-with-dotenvx.sh');

    fs.mkdirSync(dockerDir, { recursive: true });
    fs.copyFileSync(sourceEntrypoint, entrypoint);
    fs.chmodSync(entrypoint, 0o755);

    const result = spawnSync(entrypoint, ['node', '-e', 'console.log("ok")'], {
      env: {
        ...process.env,
        APP_ENV: 'production',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });

  it('runs the command directly when env file loading is disabled', () => {
    const repoRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'roomote-entrypoint-'),
    );
    const dockerDir = path.join(repoRoot, '.docker');
    const sourceEntrypoint = path.resolve(
      path.dirname(__filename),
      '../../../../.docker/run-with-dotenvx.sh',
    );
    const entrypoint = path.join(dockerDir, 'run-with-dotenvx.sh');

    fs.mkdirSync(dockerDir, { recursive: true });
    fs.copyFileSync(sourceEntrypoint, entrypoint);
    fs.chmodSync(entrypoint, 0o755);
    fs.writeFileSync(path.join(repoRoot, '.env.local'), 'DATABASE_URL=x\n');

    const result = spawnSync(entrypoint, ['node', '-e', 'console.log("ok")'], {
      env: {
        ...process.env,
        APP_ENV: 'production',
        ROOMOTE_DOCKER_LOAD_ENV_FILE: 'false',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });
});
