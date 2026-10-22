import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const installer = resolve(
  import.meta.dirname,
  '../../.docker/sandbox/install-worker.sh',
);
const source = readFileSync(installer, 'utf8');

test('worker bootstrap rejects vulnerable restored runtimes before installation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'worker-tls-'));
  try {
    writeFileSync(
      join(directory, 'node'),
      '#!/bin/sh\nprintf "%s\\n" "$TEST_NODE_VERSION"\n',
      { mode: 0o755 },
    );
    const environment = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      // A rejected runtime must not get far enough to extract this archive.
      WORKER_RELEASE_ARCHIVE_PATH: join(directory, 'worker.tar.gz'),
    };
    writeFileSync(environment.WORKER_RELEASE_ARCHIVE_PATH, 'not an archive');

    for (const version of [
      'v20.20.0',
      'v22.17.1',
      'v22.23.3',
      'v24.22.0',
      'v26.12.0',
      'v24.22.1-rc.1',
      'unknown',
    ]) {
      const result = spawnSync('bash', [installer], {
        encoding: 'utf8',
        env: { ...environment, TEST_NODE_VERSION: version },
      });
      assert.equal(result.status, 1, version);
      assert.match(
        result.stderr,
        /does not meet the TLS trust minimum/,
        version,
      );
      assert.doesNotMatch(
        result.stdout,
        /Installing worker|Removing old worker|worker_install duration/,
        version,
      );
      assert.equal(
        readFileSync(environment.WORKER_RELEASE_ARCHIVE_PATH, 'utf8'),
        'not an archive',
      );
    }

    // Execute the real function definitions without running installation on the
    // test host. Positive cases must pass the guard, not a mocked comparator.
    const definitions = source.slice(
      0,
      source.indexOf('# Fail fast per phase:'),
    );
    assert.ok(definitions.includes('validate_tls_runtime()'));
    for (const version of [
      'v22.23.4',
      'v22.24.0',
      'v24.22.1',
      'v24.23.0',
      'v26.12.1',
    ]) {
      const result = spawnSync('bash', [], {
        input: `${definitions}\nvalidate_tls_runtime\n`,
        encoding: 'utf8',
        env: { ...environment, TEST_NODE_VERSION: version },
      });
      assert.equal(result.status, 0, `${version}: ${result.stderr}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
