import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

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
    'roomote.example.com\rnot-a-domain',
    'roomote.example.com\r',
    'roomote.example.com\r\nnot-a-domain',
  ]) {
    const result = validateDomain(domain);
    assert.equal(result.status, 1, `${domain} was accepted`);
    assert.match(result.stderr, /error: invalid domain:/);
  }
});

test('successful deploys record the installed release after readiness', () => {
  for (const script of ['deploy.sh', 'upgrade.sh']) {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'scripts', script),
      'utf8',
    );
    const readiness = source.indexOf('up -d --wait --wait-timeout 600');
    const announcement = source.indexOf(
      '/roomote/.docker/app/entrypoint.sh release-announcement',
    );

    assert.notEqual(readiness, -1, `${script} must wait for readiness`);
    assert.ok(
      announcement > readiness,
      `${script} must record the release only after readiness`,
    );
  }
});

test('the app entrypoint re-execs under an init when it runs as PID 1', (t) => {
  const entrypoint = resolve(
    import.meta.dirname,
    '..',
    '..',
    '.docker',
    'app',
    'entrypoint.sh',
  );
  const probe = spawnSync(
    'unshare',
    ['--user', '--map-root-user', '--pid', '--fork', 'true'],
    { encoding: 'utf8' },
  );
  if (probe.error || probe.status !== 0) {
    t.skip('unprivileged PID namespaces are unavailable here');
    return;
  }

  const fakeInit = resolve(import.meta.dirname, 'fake-init.sh');
  const asPid1 = spawnSync(
    'unshare',
    ['--user', '--map-root-user', '--pid', '--fork', 'sh', entrypoint, 'api'],
    {
      encoding: 'utf8',
      env: { ...process.env, ROOMOTE_INIT_BIN: fakeInit },
    },
  );
  assert.equal(asPid1.status, 0, asPid1.stderr);
  assert.equal(asPid1.stdout.trim(), `init: -- ${entrypoint} api`);

  // Not PID 1 (already under an init): no re-exec, so the fake init is
  // never reached and the script proceeds to its own dispatch.
  const notPid1 = spawnSync('sh', [entrypoint, 'no-such-service'], {
    encoding: 'utf8',
    env: { ...process.env, ROOMOTE_INIT_BIN: fakeInit },
  });
  assert.doesNotMatch(notPid1.stdout, /^init:/);
});
