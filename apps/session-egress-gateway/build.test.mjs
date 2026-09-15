import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('.', import.meta.url));
const sha = '2393dd175a8c419153fb49917fdeceb94cd9ed59';
const archive = readFileSync(join(root, '.build', `${sha}.tar.gz`));

for (const corrupt of [false, true]) {
  test(`prepare ${corrupt ? 'rejects mismatched' : 'accepts pinned'} archive without GNU sha256sum`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'iron-build-'));
    try {
      for (const name of ['build.sh', 'iron.lock', 'verify-archive.mjs', 'patch-iron.mjs', 'overlay']) {
        cpSync(join(root, name), join(dir, name), { recursive: true });
      }
      mkdirSync(join(dir, '.build'));
      mkdirSync(join(dir, 'tools'));
      writeFileSync(join(dir, 'tools', 'sha256sum'), '#!/bin/sh\nprintf "unsupported GNU flags\\n" >&2\nexit 2\n', { mode: 0o755 });
      writeFileSync(join(dir, '.build', `${sha}.tar.gz`), corrupt ? Buffer.concat([archive, Buffer.from('tampered')]) : archive);
      const result = spawnSync('bash', [join(dir, 'build.sh'), 'prepare'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${join(dir, 'tools')}:${process.env.PATH}` },
      });
      if (corrupt) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /archive SHA256 mismatch/);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /651cd4745193252a997b476ea022a852428db666a59e6554cbc3e786b320d3ec/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
