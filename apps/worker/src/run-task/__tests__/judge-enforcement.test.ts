import {
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';

import { createJudgeEnforcement } from '../judge-enforcement';

vi.mock('@roomote/sdk/client', () => ({
  sdk: { taskRuns: { evaluateJudgeFileCriteria: vi.fn() } },
}));

type JudgeEvaluation = {
  id: string;
  outcome: 'pass' | 'rewrite' | 'unclear';
  confidence: number;
  probabilities: Record<'pass' | 'rewrite' | 'unclear', number>;
};

const repoPaths = (root: string) => ({ 'acme/example': root });

function createLogger() {
  return {
    runId: 1,
    filePath: '',
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function answered(
  criteria: Array<{ id: string }>,
  outcome: JudgeEvaluation['outcome'],
  confidence = 0.95,
) {
  return {
    kind: 'answered' as const,
    evaluations: criteria.map(({ id }) => ({
      id,
      outcome,
      confidence,
      probabilities: {
        pass: outcome === 'pass' ? confidence : (1 - confidence) / 2,
        rewrite: outcome === 'rewrite' ? confidence : (1 - confidence) / 2,
        unclear: outcome === 'unclear' ? confidence : (1 - confidence) / 2,
      },
    })),
  };
}

async function createRepo(policy?: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'roomote-judge-'));
  await execa('git', ['init', '-q'], { cwd: root });
  await execa('git', ['config', 'user.email', 'judge-test@example.com'], {
    cwd: root,
  });
  await execa('git', ['config', 'user.name', 'Judge Test'], { cwd: root });
  await writeFile(join(root, 'Example.tsx'), '<p>Original</p>\n');
  if (policy !== undefined) {
    await writeFile(join(root, 'JUDGE.json'), JSON.stringify(policy));
  }
  await execa('git', ['add', '.'], { cwd: root });
  await execa('git', ['commit', '-qm', 'initial'], { cwd: root });
  return root;
}

async function createEnforcement(
  root: string,
  evaluate: Parameters<typeof createJudgeEnforcement>[0]['evaluate'],
) {
  return await createJudgeEnforcement({
    runId: 1,
    repoPaths: repoPaths(root),
    logger: createLogger(),
    recordWorkerRuntimeEvent: vi.fn().mockResolvedValue(undefined),
    evaluate,
  });
}

describe('createJudgeEnforcement', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true })),
    );
  });

  it('does nothing when JUDGE.json is absent', async () => {
    const root = await createRepo();
    roots.push(root);
    const evaluate = vi.fn();
    const enforcement = await createEnforcement(root, evaluate);

    await writeFile(join(root, 'Example.tsx'), '<p>Changed</p>\n');

    await expect(enforcement.beforeTaskCompletion()).resolves.toBe('finalize');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('judges tracked changes and returns deterministic repair feedback', async () => {
    const root = await createRepo({
      criteria: [
        { rule: 'Do not include descriptions of functionality in UI text.' },
      ],
    });
    roots.push(root);
    const evaluate = vi.fn(async ({ criteria }) =>
      answered(criteria, 'rewrite'),
    );
    const enforcement = await createEnforcement(root, evaluate);

    await writeFile(join(root, 'Example.tsx'), '<p>Save your work here.</p>\n');

    const result = await enforcement.beforeTaskCompletion();

    expect(result).toMatchObject({ disposition: 'continue' });
    expect(result).toMatchObject({
      prompt: expect.objectContaining({
        prompt: expect.stringContaining('Path: Example.tsx'),
      }),
    });
    expect(result).toMatchObject({
      prompt: expect.objectContaining({
        prompt: expect.stringContaining(
          'Rule: Do not include descriptions of functionality in UI text.',
        ),
      }),
    });
    expect(result).toMatchObject({
      prompt: expect.objectContaining({
        prompt: expect.stringContaining('Confidence: 0.95'),
      }),
    });
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          path: 'Example.tsx',
          finalContent: '<p>Save your work here.</p>\n',
        }),
      }),
    );
  });

  it('matches repository-relative globs and applies default/custom thresholds', async () => {
    const globRoot = await createRepo({
      criteria: [{ rule: 'Use sentence case.', files: ['apps/web/**/*.tsx'] }],
    });
    roots.push(globRoot);
    await execa('mkdir', ['-p', 'apps/web/src'], { cwd: globRoot });
    const globEvaluate = vi.fn(async ({ criteria }) =>
      answered(criteria, 'rewrite'),
    );
    const globEnforcement = await createEnforcement(globRoot, globEvaluate);
    await writeFile(join(globRoot, 'apps/web/src/Example.tsx'), 'changed\n');
    await expect(globEnforcement.beforeTaskCompletion()).resolves.toMatchObject(
      {
        disposition: 'continue',
      },
    );
    expect(globEvaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ path: 'apps/web/src/Example.tsx' }),
      }),
    );

    const defaultRoot = await createRepo({
      criteria: [{ rule: 'Use sentence case.' }],
    });
    roots.push(defaultRoot);
    const defaultEvaluate = vi.fn(async ({ criteria }) =>
      answered(criteria, 'rewrite', 0.84),
    );
    const defaultEnforcement = await createEnforcement(
      defaultRoot,
      defaultEvaluate,
    );
    await writeFile(join(defaultRoot, 'Example.tsx'), 'changed\n');
    await expect(defaultEnforcement.beforeTaskCompletion()).resolves.toBe(
      'finalize',
    );

    const customRoot = await createRepo({
      criteria: [{ rule: 'Use sentence case.', threshold: 0.8 }],
    });
    roots.push(customRoot);
    const customEvaluate = vi.fn(async ({ criteria }) =>
      answered(criteria, 'rewrite', 0.84),
    );
    const customEnforcement = await createEnforcement(
      customRoot,
      customEvaluate,
    );
    await writeFile(join(customRoot, 'Example.tsx'), 'changed\n');
    await expect(
      customEnforcement.beforeTaskCompletion(),
    ).resolves.toMatchObject({
      disposition: 'continue',
    });
  });

  it.each([
    ['pass', 0.99],
    ['unclear', 0.99],
    ['rewrite', 0.79],
  ] as const)(
    '%s and below-threshold rewrite do not interrupt',
    async (outcome, confidence) => {
      const root = await createRepo({
        criteria: [{ rule: 'Use sentence case.' }],
      });
      roots.push(root);
      const evaluate = vi.fn(async ({ criteria }) =>
        answered(criteria, outcome, confidence),
      );
      const enforcement = await createEnforcement(root, evaluate);
      await writeFile(join(root, 'Example.tsx'), 'changed\n');

      await expect(enforcement.beforeTaskCompletion()).resolves.toBe(
        'finalize',
      );
    },
  );

  it('sees shell-created files, skips binary/deleted files, and re-evaluates changed content', async () => {
    const root = await createRepo({
      criteria: [{ rule: 'Use sentence case.' }],
    });
    roots.push(root);
    const evaluate = vi.fn(async ({ criteria }) =>
      answered(criteria, 'rewrite'),
    );
    const enforcement = await createEnforcement(root, evaluate);

    await writeFile(join(root, 'generated.tsx'), 'created by shell\n');
    await expect(enforcement.beforeTaskCompletion()).resolves.toMatchObject({
      disposition: 'continue',
    });
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ path: 'generated.tsx' }),
      }),
    );

    await writeFile(join(root, 'Example.tsx'), 'changed once\n');
    await enforcement.beforeTaskCompletion();
    expect(evaluate).toHaveBeenCalledTimes(2);

    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
    await execa('rm', ['Example.tsx'], { cwd: root });
    await enforcement.beforeTaskCompletion();
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('fails open with a warning for malformed policy or unavailable/erroring models', async () => {
    const malformedRoot = await createRepo({ criteria: [] });
    roots.push(malformedRoot);
    const malformedLogger = createLogger();
    const malformedEvents = vi.fn().mockResolvedValue(undefined);
    const malformed = await createJudgeEnforcement({
      runId: 1,
      repoPaths: repoPaths(malformedRoot),
      logger: malformedLogger,
      recordWorkerRuntimeEvent: malformedEvents,
    });
    await expect(malformed.beforeTaskCompletion()).resolves.toBe('finalize');
    expect(malformedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('JUDGE.json is invalid'),
    );
    expect(malformedEvents).toHaveBeenCalledWith(
      expect.objectContaining({ details: { reason: 'judge_policy_invalid' } }),
    );

    for (const kind of ['unavailable', 'error'] as const) {
      const root = await createRepo({
        criteria: [{ rule: 'Use sentence case.' }],
      });
      roots.push(root);
      const logger = createLogger();
      const evaluate = vi.fn(async () => ({ kind }));
      const enforcement = await createJudgeEnforcement({
        runId: 1,
        repoPaths: repoPaths(root),
        logger,
        evaluate,
      });
      await writeFile(join(root, 'Example.tsx'), 'changed\n');
      await expect(enforcement.beforeTaskCompletion()).resolves.toBe(
        'finalize',
      );
      expect(logger.warn).toHaveBeenCalledOnce();
    }
  });

  it('keeps valid repository enforcement when another repository policy is malformed', async () => {
    const invalidRoot = await createRepo({ criteria: [] });
    const validRoot = await createRepo({
      criteria: [{ rule: 'Use sentence case.' }],
    });
    roots.push(invalidRoot, validRoot);
    const logger = createLogger();
    const evaluate = vi.fn(async ({ criteria }) =>
      answered(criteria, 'rewrite'),
    );
    const enforcement = await createJudgeEnforcement({
      runId: 1,
      repoPaths: { invalid: invalidRoot, valid: validRoot },
      logger,
      evaluate,
    });

    await writeFile(join(validRoot, 'Example.tsx'), 'changed\n');

    await expect(enforcement.beforeTaskCompletion()).resolves.toMatchObject({
      disposition: 'continue',
    });
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({ path: 'Example.tsx' }),
      }),
    );
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('batches policies larger than the judgment RPC limit', async () => {
    const root = await createRepo({
      criteria: Array.from({ length: 65 }, (_, index) => ({
        rule: `Rule ${index}`,
      })),
    });
    roots.push(root);
    const evaluate = vi.fn(async ({ criteria }) => answered(criteria, 'pass'));
    const enforcement = await createEnforcement(root, evaluate);

    await writeFile(join(root, 'Example.tsx'), 'changed\n');

    await expect(enforcement.beforeTaskCompletion()).resolves.toBe('finalize');
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls.map(([input]) => input.criteria.length)).toEqual(
      [64, 1],
    );
  });

  it('skips changed symlinks and other non-regular paths before hashing or reading them', async () => {
    const root = await createRepo({
      criteria: [{ rule: 'Use sentence case.', files: ['*.tsx'] }],
    });
    roots.push(root);
    await writeFile(join(root, 'outside.txt'), 'outside checkout content\n');
    const enforcement = await createEnforcement(root, vi.fn());
    await symlink('outside.txt', join(root, 'link.tsx'));
    await execa('mkdir', ['directory.tsx'], { cwd: root });

    await expect(enforcement.beforeTaskCompletion()).resolves.toBe('finalize');
  });

  it('skips hard-linked changed files and never truncates a hard-linked policy target', async () => {
    const root = await createRepo({
      criteria: [{ rule: 'Use sentence case.', files: ['*.tsx'] }],
    });
    const outsideRoot = await mkdtemp(
      join(tmpdir(), 'roomote-judge-hardlink-'),
    );
    roots.push(root, outsideRoot);
    const outsidePath = join(outsideRoot, 'target.txt');
    await writeFile(outsidePath, 'must remain unchanged\n');
    const enforcement = await createEnforcement(root, vi.fn());
    await link(outsidePath, join(root, 'linked.tsx'));

    await expect(enforcement.beforeTaskCompletion()).resolves.toBe('finalize');
    await expect(readFile(outsidePath, 'utf8')).resolves.toBe(
      'must remain unchanged\n',
    );

    const policyOutsidePath = join(outsideRoot, 'policy-target.txt');
    await writeFile(policyOutsidePath, 'policy target must remain unchanged\n');
    await execa('rm', ['JUDGE.json'], { cwd: root });
    await link(policyOutsidePath, join(root, 'JUDGE.json'));
    await writeFile(join(root, 'Example.tsx'), 'changed\n');

    await expect(enforcement.beforeTaskCompletion()).resolves.toMatchObject({
      disposition: 'fail',
    });
    await expect(readFile(policyOutsidePath, 'utf8')).resolves.toBe(
      'policy target must remain unchanged\n',
    );
  });

  it('does not follow a replacement symlink while restoring JUDGE.json', async () => {
    const root = await createRepo({
      criteria: [{ rule: 'Use sentence case.' }],
    });
    const outsideRoot = await mkdtemp(join(tmpdir(), 'roomote-judge-target-'));
    roots.push(root, outsideRoot);
    const outsidePath = join(outsideRoot, 'target.txt');
    await writeFile(outsidePath, 'must remain unchanged\n');
    const enforcement = await createEnforcement(root, vi.fn());

    await execa('rm', ['JUDGE.json'], { cwd: root });
    await symlink(outsidePath, join(root, 'JUDGE.json'));
    await writeFile(join(root, 'Example.tsx'), 'changed\n');

    await expect(enforcement.beforeTaskCompletion()).resolves.toMatchObject({
      disposition: 'fail',
    });
    await expect(readFile(outsidePath, 'utf8')).resolves.toBe(
      'must remain unchanged\n',
    );
  });

  it('restores immutable JUDGE.json, allows successful repair, and blocks after three failed rounds', async () => {
    const root = await createRepo({
      criteria: [{ rule: 'Use sentence case.' }],
    });
    roots.push(root);
    const evaluate = vi
      .fn()
      .mockImplementation(async ({ criteria }) =>
        answered(criteria, 'rewrite'),
      );
    const enforcement = await createEnforcement(root, evaluate);
    const startupPolicy = await readFile(join(root, 'JUDGE.json'), 'utf8');

    await writeFile(join(root, 'JUDGE.json'), JSON.stringify({ criteria: [] }));
    await writeFile(join(root, 'Example.tsx'), 'still changed\n');
    const first = await enforcement.beforeTaskCompletion();
    expect(first).toMatchObject({ disposition: 'continue' });
    expect(await readFile(join(root, 'JUDGE.json'), 'utf8')).toBe(
      startupPolicy,
    );

    await writeFile(join(root, 'Example.tsx'), 'repaired\n');
    evaluate.mockImplementation(async ({ criteria }) =>
      answered(criteria, 'pass'),
    );
    await expect(enforcement.beforeTaskCompletion()).resolves.toBe('finalize');

    const blockingRoot = await createRepo({
      criteria: [{ rule: 'Use sentence case.' }],
    });
    roots.push(blockingRoot);
    const blockingEvaluate = vi.fn(async ({ criteria }) =>
      answered(criteria, 'rewrite'),
    );
    const blocking = await createEnforcement(blockingRoot, blockingEvaluate);
    await writeFile(join(blockingRoot, 'Example.tsx'), 'never repaired\n');
    await expect(blocking.beforeTaskCompletion()).resolves.toMatchObject({
      disposition: 'continue',
    });
    await expect(blocking.beforeTaskCompletion()).resolves.toMatchObject({
      disposition: 'continue',
    });
    await expect(blocking.beforeTaskCompletion()).resolves.toMatchObject({
      disposition: 'continue',
    });
    await expect(blocking.beforeTaskCompletion()).resolves.toMatchObject({
      disposition: 'fail',
    });
  });
});
