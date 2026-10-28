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

test('worker bootstrap warns about outdated restored runtimes without stopping', () => {
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
    };

    // Execute the real function definitions without running installation on the
    // test host. Positive cases must pass the guard, not a mocked comparator.
    const definitions = source.slice(
      0,
      source.indexOf('# Fail fast per phase:'),
    );
    assert.ok(definitions.includes('validate_tls_runtime()'));
    const run = (version) =>
      spawnSync('bash', [], {
        input: `${definitions}\nvalidate_tls_runtime\n`,
        encoding: 'utf8',
        env: { ...environment, TEST_NODE_VERSION: version },
      });
    // Outdated runtimes are reported but do not stop the bootstrap: a hard
    // stop would break every task launched from an older snapshot until the
    // daily environment refresh rebuilds it from the current base image.
    for (const version of [
      'v20.20.0',
      'v22.17.1',
      'v22.23.3',
      'v24.22.0',
      'v26.12.0',
      'v24.22.1-rc.1',
      'unknown',
    ]) {
      const result = run(version);
      assert.equal(result.status, 0, `${version}: ${result.stderr}`);
      assert.match(
        result.stderr,
        /Warning: Node .* does not meet the TLS trust minimum/,
        version,
      );
    }
    for (const version of [
      'v22.23.4',
      'v22.24.0',
      'v24.22.1',
      'v24.23.0',
      'v26.12.1',
    ]) {
      const result = run(version);
      assert.equal(result.status, 0, `${version}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /TLS trust minimum/, version);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('worker bootstrap warns when a restored snapshot baked an older release', () => {
  const directory = mkdtempSync(join(tmpdir(), 'worker-compat-'));
  try {
    writeFileSync(join(directory, 'VERSION'), 'v1.19.0\n');
    const definitions = source.slice(
      0,
      source.indexOf('# Fail fast per phase:'),
    );
    assert.ok(definitions.includes('validate_worker_compatibility()'));
    const run = (variables) =>
      spawnSync('bash', [], {
        input: `${definitions}\nWORKER_DIR=${JSON.stringify(directory)}\n${variables}\nvalidate_worker_compatibility\n`,
        encoding: 'utf8',
        env: { ...process.env, ROOMOTE_APPLICATION_PRODUCT_VERSION: '' },
      });

    // Task snapshots cannot boot fresh, so an older baked release only warns.
    const stale = run(
      'APPLICATION_PRODUCT_VERSION=1.19.0\nBAKED_WORKER_PRODUCT_VERSION=1.18.0',
    );
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(
      stale.stderr,
      /Warning: worker release v1\.19\.0 differs from baked_worker_product_version 1\.18\.0/,
    );

    // The worker must still match the application release it serves.
    const mismatched = run(
      'APPLICATION_PRODUCT_VERSION=1.18.2\nBAKED_WORKER_PRODUCT_VERSION=1.19.0',
    );
    assert.equal(mismatched.status, 1);
    assert.match(
      mismatched.stderr,
      /Error: worker release v1\.19\.0 is incompatible with application_product_version 1\.18\.2/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
