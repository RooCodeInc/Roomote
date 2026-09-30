import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const { evaluate } = vi.hoisted(() => ({ evaluate: vi.fn() }));
vi.mock('../judge-file', () => ({ evaluateRepositoryJudgement: evaluate }));
import { checkLocalRepositoryJudgement } from '../judgement-local';
const exec = promisify(execFile);
let cwd: string;
beforeEach(async () => {
  evaluate
    .mockReset()
    .mockResolvedValue({ outcome: 'violation', confidence: 0.99 });
  cwd = await mkdtemp(join(tmpdir(), 'judgement-local-'));
  await exec('git', ['init', '-q'], { cwd });
  await mkdir(join(cwd, '.judgement'));
  await writeFile(
    join(cwd, '.judgement/rules.json'),
    JSON.stringify({ criteria: [{ rule: 'Use lowercase session.' }] }),
  );
  await writeFile(join(cwd, 'example.md'), 'new Session checks');
  await exec('git', ['add', '.'], { cwd });
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
it('uses Roomote inference without a standalone key and forwards the staged patch', async () => {
  const report = await checkLocalRepositoryJudgement({ cwd });
  expect(report.status).toBe('violation');
  expect(evaluate).toHaveBeenCalledWith(
    expect.objectContaining({
      focusPaths: ['example.md'],
      evidence: expect.arrayContaining([
        expect.objectContaining({ kind: 'patch' }),
      ]),
    }),
  );
});
it('explains unavailable deployment inference', async () => {
  evaluate.mockResolvedValue(null);
  const report = await checkLocalRepositoryJudgement({ cwd });
  expect(report.status).toBe('incomplete');
  expect(report.messages.join(' ')).toContain('Settings > Models');
});
it('sanitizes provider failures', async () => {
  evaluate.mockRejectedValue(new Error('secret provider details'));
  const report = await checkLocalRepositoryJudgement({ cwd });
  expect(report.status).toBe('incomplete');
  expect(JSON.stringify(report)).not.toContain('secret provider details');
  expect(report.messages.join(' ')).toContain('Verify the local database');
});
it('does not load inference for a dry run', async () => {
  await checkLocalRepositoryJudgement({ cwd, dryRun: true });
  expect(evaluate).not.toHaveBeenCalled();
});

it('uses the same Roomote evaluator for the shared rule example suite', async () => {
  const { testRules } = await import('@roo-code/judgement');
  const { evaluateLocalRepositoryJudgement } =
    await import('../judgement-local');
  await mkdir(join(cwd, '.judgement/examples'));
  await writeFile(
    join(cwd, '.judgement/examples/criterion_1.json'),
    JSON.stringify({
      ruleId: 'criterion_1',
      examples: [
        {
          name: 'capital',
          before: 'session',
          after: 'Session',
          expected: 'violation',
        },
      ],
    }),
  );
  const report = await testRules({
    cwd,
    repeats: 1,
    evaluate: evaluateLocalRepositoryJudgement,
  });
  expect(report.status).toBe('pass');
  expect(evaluate).toHaveBeenCalled();
  expect(report.reports[0]?.results[0]?.answers[0]).toMatchObject({
    confidence: 0.99,
  });
});

it('does not expose backend errors in example suite reports', async () => {
  const { testRules } = await import('@roo-code/judgement');
  const { evaluateLocalRepositoryJudgement } =
    await import('../judgement-local');
  await mkdir(join(cwd, '.judgement/examples'));
  await writeFile(
    join(cwd, '.judgement/examples/criterion_1.json'),
    JSON.stringify({
      ruleId: 'criterion_1',
      examples: [
        {
          name: 'capital',
          before: 'session',
          after: 'Session',
          expected: 'violation',
        },
      ],
    }),
  );
  evaluate.mockRejectedValue(new Error('secret provider details'));
  const report = await testRules({
    cwd,
    repeats: 1,
    evaluate: evaluateLocalRepositoryJudgement,
  });
  expect(report.status).toBe('fail');
  expect(report.reports[0]?.results[0]?.operationalFailure).toBe(true);
  expect(JSON.stringify(report)).not.toContain('secret provider details');
});
