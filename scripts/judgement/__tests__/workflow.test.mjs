import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = YAML.parse(
  readFileSync(join(root, '.github/workflows/judgement.yml'), 'utf8'),
);
const require = createRequire(join(root, 'packages/cloud-agents/package.json'));
const { check } = await import(
  pathToFileURL(require.resolve('@roo-code/judgement')).href
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
  for (const outcome of ['success', 'failure', 'skipped', 'cancelled']) {
    const output = execFileSync('bash', ['-c', publish], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CHECK_OUTCOME: outcome,
        PR_HEAD: 'a'.repeat(40),
        GITHUB_REPOSITORY: 'example/repo',
      },
    });
    assert.match(
      output,
      new RegExp(`state=${outcome === 'success' ? 'success' : 'failure'}\\n`),
    );
  }
});
