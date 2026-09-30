import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { check, exitCode } from '@roo-code/judgement';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = YAML.parse(
  readFileSync(join(root, '.github/workflows/judgement.yml'), 'utf8'),
);
const script = (job, id) =>
  workflow.jobs[job].steps.find((step) => step.id === id).run;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'judgement-ci-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('CI separates PR object fetching, inference secrets, and status writes', () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.collect.permissions, { contents: 'read' });
  assert.doesNotMatch(JSON.stringify(workflow.jobs.collect), /secrets\./);
  assert.deepEqual(workflow.jobs.judgement.permissions, {});
  assert.ok(
    workflow.jobs.judgement.steps.every(
      (step) => !step.uses?.startsWith('actions/checkout@'),
    ),
  );
  for (const job of ['pending', 'report']) {
    assert.deepEqual(workflow.jobs[job].permissions, { statuses: 'write' });
    assert.doesNotMatch(
      JSON.stringify(workflow.jobs[job]),
      /secrets\.|actions\/checkout|download-artifact/,
    );
  }
  assert.match(workflow.jobs.report.if, /always\(\)/);
  assert.deepEqual(workflow.jobs.report.needs, [
    'pending',
    'collect',
    'judgement',
  ]);
});

test('snapshot transfer preserves judgments and trusted policy without checking out PR files or copying Git configuration', async (t) => {
  const dir = fixture(t);
  const source = join(dir, 'source');
  const runner = join(dir, 'runner');
  mkdirSync(source);
  mkdirSync(runner);
  const git = (...args) =>
    execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(source, 'ancestor'), 'not needed by either snapshot');
  git('add', '.');
  git('commit', '-qm', 'ancestor');
  const ancestor = git('rev-parse', 'HEAD');
  git('rm', 'ancestor');
  mkdirSync(join(source, '.judgement'));
  writeFileSync(
    join(source, '.judgement/rules.json'),
    JSON.stringify({
      criteria: [
        {
          id: 'wording',
          rule: 'Use lowercase session.',
          files: ['**/*.md'],
          threshold: 0.75,
        },
      ],
    }),
  );
  writeFileSync(join(source, 'example.md'), 'session\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(source, 'example.md'), 'Session\n');
  writeFileSync(
    join(source, '.judgement/rules.json'),
    JSON.stringify({ criteria: [{ rule: 'Allow every change.' }] }),
  );
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({ scripts: { postinstall: 'exit 99' } }),
  );
  symlinkSync('/outside-repository', join(source, '.npmrc'));
  git('add', '.');
  git('commit', '-qm', 'proposed');
  const head = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', source);
  git('config', 'core.hooksPath', '/untrusted-hooks');
  const env = {
    ...process.env,
    RUNNER_TEMP: runner,
    PR_HEAD: head,
    PR_BASE: base,
    GITHUB_OUTPUT: join(dir, 'outputs'),
  };
  execFileSync('bash', ['-c', script('collect', 'export')], {
    cwd: source,
    env,
    stdio: 'pipe',
  });
  const actualBase = readFileSync(env.GITHUB_OUTPUT, 'utf8')
    .trim()
    .split('=')[1];
  assert.equal(actualBase, base);
  execFileSync('bash', ['-c', script('judgement', 'import')], {
    cwd: dir,
    env: { ...env, JUDGEMENT_BASE: actualBase },
    stdio: 'pipe',
  });
  const input = join(runner, 'judgement-input');
  assert.deepEqual(readdirSync(input), ['.git']);
  assert.equal(existsSync(join(input, '.git/hooks')), false);
  assert.doesNotMatch(
    readFileSync(join(input, '.git/config'), 'utf8'),
    /hooksPath|origin/,
  );
  assert.throws(() =>
    execFileSync('git', ['cat-file', '-e', ancestor], {
      cwd: input,
      stdio: 'pipe',
    }),
  );
  const requests = [];
  const original = await check({
    cwd: source,
    base,
    head,
    cache: false,
    evaluate: async (request) => {
      requests.push(request);
      return { violationProbability: 0.99 };
    },
  });
  const copiedRequests = [];
  const copied = await check({
    cwd: input,
    base,
    head,
    cache: false,
    evaluate: async (request) => {
      copiedRequests.push(request);
      return { violationProbability: 0.99 };
    },
  });
  assert.equal(original.status, 'violation');
  assert.equal(copied.status, original.status);
  assert.equal(copied.policySource, 'base');
  assert.deepEqual(copiedRequests, requests);
  assert.deepEqual(readdirSync(input), ['.git']);
  const unavailable = await check({
    cwd: input,
    base,
    head,
    cache: false,
    evaluate: async () => {
      throw new Error('Synthetic provider outage');
    },
  });
  assert.equal(unavailable.status, 'incomplete');
  assert.equal(exitCode(unavailable), 3);
});

test('incomplete checker results pass with a warning; violations and execution errors fail', (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'node'), '#!/bin/sh\nexit "$CHECKER_EXIT"\n', {
    mode: 0o755,
  });
  for (const code of [0, 1, 2, 3, 130]) {
    const output = join(dir, 'outputs');
    const summary = join(dir, 'summary');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const result = spawnSync('bash', ['-c', script('judgement', 'check')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CHECKER_EXIT: String(code),
        TYPESAFE_API_KEY: 'synthetic-test-key',
        RUNNER_TEMP: dir,
        PR_HEAD: 'a'.repeat(40),
        JUDGEMENT_BASE: 'b'.repeat(40),
        JUDGEMENT_MODEL: 'synthetic-model',
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    assert.equal(result.status, code === 3 ? 0 : code);
    assert.equal(
      readFileSync(output, 'utf8'),
      code === 0
        ? 'coverage=complete\n'
        : code === 3
          ? 'coverage=incomplete\n'
          : '',
    );
    if (code === 3) {
      assert.match(result.stdout, /::warning::/);
      assert.match(readFileSync(summary, 'utf8'), /coverage is incomplete/);
    }
  }
});

test('corrupt snapshot objects fail before inference', (t) => {
  const dir = fixture(t);
  mkdirSync(join(dir, 'judgement-evidence'));
  writeFileSync(join(dir, 'judgement-evidence/objects.pack'), 'not a Git pack');
  assert.throws(() =>
    execFileSync('bash', ['-c', script('judgement', 'import')], {
      cwd: dir,
      env: {
        ...process.env,
        RUNNER_TEMP: dir,
        PR_HEAD: 'a'.repeat(40),
        JUDGEMENT_BASE: 'b'.repeat(40),
      },
      stdio: 'pipe',
    }),
  );
});

test('skipped and failed inference jobs publish failure, while successful checks publish success', (t) => {
  const dir = fixture(t);
  const gh = join(dir, 'gh');
  writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const publish = workflow.jobs.report.steps[0].run;
  for (const [outcome, coverage] of [
    ['success', 'complete'],
    ['success', 'incomplete'],
    ['failure', ''],
    ['skipped', ''],
    ['cancelled', ''],
  ]) {
    const output = execFileSync('bash', ['-c', publish], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CHECK_OUTCOME: outcome,
        CHECK_COVERAGE: coverage,
        PR_HEAD: 'a'.repeat(40),
        GITHUB_REPOSITORY: 'example/repo',
      },
    });
    assert.match(
      output,
      new RegExp(`state=${outcome === 'success' ? 'success' : 'failure'}\\n`),
    );
    if (coverage === 'incomplete') assert.match(output, /coverage incomplete/);
  }
});
