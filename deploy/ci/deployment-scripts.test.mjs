import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';

const validationRunner = resolve(
  import.meta.dirname,
  'validate-domain-subprocess.sh',
);

function validateDomain(domain) {
  // Pass the runner script and the candidate domain as explicit positional
  // arguments to `bash` rather than interpolating either into a `-c` shell
  // string, so no value here is parsed as shell command text.
  return spawnSync('bash', [validationRunner, domain], { encoding: 'utf8' });
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
    'roomote.example.com\nnot-a-domain',
  ]) {
    const result = validateDomain(domain);
    assert.equal(result.status, 1, `${domain} was accepted`);
    assert.match(result.stderr, /error: invalid domain:/);
  }
});
