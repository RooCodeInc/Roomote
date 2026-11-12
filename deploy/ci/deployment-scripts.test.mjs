import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { basename, join, resolve } from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

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

test('deployment paths preserve nested missing parents without creating them during resolution', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roomote-paths-'));
  const lib = resolve(import.meta.dirname, '..', 'scripts', 'lib.sh');
  try {
    mkdirSync(join(cwd, 'existing dir'));
    for (const path of [
      join(cwd, 'missing', 'nested', 'backups'),
      'missing/nested/backups',
      'missing parents/nested backups/',
      'existing dir/new leaf',
      'existing dir',
      '-missing/nested',
    ]) {
      const result = spawnSync(
        'bash',
        [
          '-c',
          'source "$1"; resolved=$(abs_path "$2"); printf "%s\\n" "$resolved"',
          'path-test',
          lib,
          path,
        ],
        { cwd, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout.trimEnd(),
        path.startsWith('/') ? path : `${cwd}/${path}`,
      );
      assert.equal(result.stderr, '');
    }
    assert.equal(existsSync(join(cwd, 'missing')), false);
    const state = spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; customer_state_dir demo; terraform_state_file demo; terraform_tfvars_file demo',
        'path-test',
        lib,
      ],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          ROOMOTE_DEPLOY_STATE_DIR: `${cwd}/missing/state`,
        },
      },
    );
    assert.equal(state.status, 0, state.stderr);
    assert.deepEqual(state.stdout.trim().split('\n'), [
      `${cwd}/missing/state/demo`,
      `${cwd}/missing/state/demo/terraform.tfstate`,
      `${cwd}/missing/state/demo/terraform.tfvars`,
    ]);
    assert.equal(existsSync(join(cwd, 'missing')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('backup downloads to the requested nested output through the actual CLI', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roomote-backup-path-'));
  const script = resolve(
    import.meta.dirname,
    '..',
    'scripts',
    'roomote-deploy',
  );
  try {
    const bin = join(cwd, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ssh'), '#!/usr/bin/env bash\nexit 0\n', {
      mode: 0o755,
    });
    // Keep even a baseline regression from writing an accidental root path.
    writeFileSync(
      join(bin, 'mkdir'),
      `#!/usr/bin/env bash
set -euo pipefail
destination="\${@: -1}"
case "$destination" in
  "$PWD"/*) exec /bin/mkdir "$@" ;;
  *) printf 'refused unexpected output directory: %s\\n' "$destination" >&2; exit 42 ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, 'scp'),
      `#!/usr/bin/env bash
set -euo pipefail
source_path="\${@: -2:1}"
destination="\${@: -1}"
if [[ "$source_path" == root@example.invalid:* ]]; then
  printf 'disposable encrypted bundle fixture\\n' > "$destination/$(basename -- "$source_path")"
fi
`,
      { mode: 0o755 },
    );
    const passphrase = join(cwd, 'passphrase');
    writeFileSync(passphrase, 'disposable passphrase\n');
    for (const output of [
      'missing/nested backups',
      join(cwd, 'absolute missing', 'backups'),
    ]) {
      const result = spawnSync(
        'bash',
        [
          script,
          'backup',
          '--customer',
          'demo',
          '--host',
          'example.invalid',
          '--output-dir',
          output,
          '--passphrase-file',
          passphrase,
        ],
        {
          cwd,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const complete = result.stdout
        .split('\n')
        .find((line) => line.startsWith('Backup complete: '));
      assert.ok(complete, result.stdout);
      const bundle = complete.slice('Backup complete: '.length);
      assert.equal(
        bundle,
        `${output.startsWith('/') ? output : `${cwd}/${output}`}/${basename(bundle)}`,
      );
      assert.equal(
        readFileSync(bundle, 'utf8'),
        'disposable encrypted bundle fixture\n',
      );
    }
    const missingInput = spawnSync(
      'bash',
      [
        script,
        'backup',
        '--customer',
        'demo',
        '--host',
        'example.invalid',
        '--output-dir',
        'untouched/backups',
        '--passphrase-file',
        'absent/secret',
      ],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    assert.equal(missingInput.status, 1);
    assert.match(missingInput.stderr, /passphrase file not found or empty/);
    assert.equal(existsSync(join(cwd, 'untouched')), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
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
