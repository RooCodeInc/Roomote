import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const gateway = dirname(fileURLToPath(import.meta.url));
const repository = resolve(gateway, '../..');

test('production plus session-egress overlay resolves every local Dockerfile COPY source', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'roomote-compose-contract-'));
  try {
    const result = spawnSync(
      'docker',
      [
        'compose',
        '--env-file',
        '/dev/null',
        '-f',
        join(repository, 'deploy/compose/docker-compose.prod.yml'),
        '-f',
        join(repository, 'deploy/compose/docker-compose.session-egress.yml'),
        'config',
        '--format',
        'json',
        '--no-interpolate',
        '--no-env-resolution',
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: configDir,
          DOCKER_CONFIG: configDir,
        },
      },
    );
    assert.equal(
      result.status,
      0,
      result.stderr ||
        'Docker Compose config is required (no daemon or provisioning)',
    );
    const model = JSON.parse(result.stdout);
    const build = model.services['session-egress-gateway'].build;
    assert.equal(resolve(build.context), gateway);
    const dockerfile = resolve(build.context, build.dockerfile);
    assert.equal(dockerfile, join(gateway, 'Dockerfile'));
    const checked = [];
    for (const line of readFileSync(dockerfile, 'utf8').split('\n')) {
      if (!line.startsWith('COPY ') || line.includes('--from=')) continue;
      const sources = line.split(/\s+/).slice(1, -1);
      for (const source of sources) {
        assert.ok(
          existsSync(resolve(build.context, source)),
          `Missing build-context source: ${source}`,
        );
        checked.push(source);
      }
    }
    for (const expected of [
      'iron.lock',
      'build.sh',
      'verify-archive.mjs',
      'patch-iron.mjs',
      'overlay',
    ]) {
      assert.ok(
        checked.includes(expected),
        `Expected pinned build input ${expected}`,
      );
    }
    assert.equal(model.services['session-egress-gateway'].read_only, true);
    const environment = model.services.controller.environment;
    assert.ok(
      Array.isArray(environment)
        ? environment.includes(
            'SESSION_EGRESS_GATEWAY_ADDR=session-egress-gateway:8443',
          )
        : environment.SESSION_EGRESS_GATEWAY_ADDR ===
            'session-egress-gateway:8443',
    );
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
