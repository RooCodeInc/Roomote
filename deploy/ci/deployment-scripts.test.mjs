import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';

const validationScript = resolve(import.meta.dirname, '../scripts/lib.sh');

function validateDomain(domain) {
  return spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; validate_domain "$2"',
      'validate-domain',
      validationScript,
      domain,
    ],
    { encoding: 'utf8' },
  );
}

test('deployment domains use valid DNS labels', () => {
  const maximumLengthDomain = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;

  for (const domain of [
    'roomote.example.com',
    'a',
    'a.example',
    `${'a'.repeat(63)}.example`,
    maximumLengthDomain,
  ]) {
    const result = validateDomain(domain);
    assert.equal(result.status, 0, `${domain}: ${result.stderr}`);
  }

  for (const domain of [
    '',
    '.example.com',
    'example.com.',
    'foo..example.com',
    '-foo.example.com',
    'foo-.example.com',
    `${'a'.repeat(64)}.example`,
    `${maximumLengthDomain}e`,
  ]) {
    const result = validateDomain(domain);
    assert.equal(result.status, 1, `${domain} was accepted`);
    assert.match(result.stderr, /error: invalid domain:/);
  }
});
