import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildCompletionGateReminder,
  clipDiffByFile,
  collectShippedDiff,
  isCompletionGateEligible,
  isLikelySourceMutatingCommand,
} from '../opencode-server/completion-gate';

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function write(repo: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}

function commit(repo: string, message: string): void {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
}

/**
 * A sandbox-style checkout: cloned from an origin whose default branch is
 * `main`, so `origin/HEAD` resolves the way it does in a task workspace.
 */
function createCheckout(options: { prBranch?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-gate-diff-'));
  tempDirs.push(root);
  const origin = path.join(root, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  write(origin, 'src/app.ts', 'export const app = 1;\n');
  commit(origin, 'initial');

  if (options.prBranch) {
    git(origin, 'checkout', '-q', '-b', 'feature');
    write(origin, 'src/guard.ts', 'export const guard = true;\n');
    commit(origin, 'add guard');
    git(origin, 'checkout', '-q', 'main');
  }

  const checkout = path.join(root, 'workspace');
  git(root, 'clone', '-q', origin, checkout);
  return checkout;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('collectShippedDiff', () => {
  it('returns null when the task changed nothing', async () => {
    await expect(collectShippedDiff(createCheckout())).resolves.toBeNull();
  });

  it('covers committed, uncommitted, and untracked work on a fresh branch', async () => {
    const repo = createCheckout();
    git(repo, 'checkout', '-q', '-b', 'task');
    write(repo, 'src/app.ts', 'export const app = 2;\n');
    commit(repo, 'bump');
    write(repo, 'src/app.ts', 'export const app = 3;\n');
    write(repo, 'src/new.ts', 'export const added = true;\n');
    write(repo, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');

    const shipped = await collectShippedDiff(repo);

    expect(shipped?.diff).toContain('+export const app = 3;');
    expect(shipped?.diff).toContain('-export const app = 1;');
    expect(shipped?.diff).toContain('+export const added = true;');
    expect(shipped?.diffStat).toContain('src/new.ts (new file)');
    expect(shipped?.diffTruncated).toBe(false);
  });

  it('leaves untracked lockfiles, snapshots, and bundles out of the patch', async () => {
    const repo = createCheckout();
    write(repo, 'packages/app/pnpm-lock.yaml', 'lockfileVersion: 9\n');
    write(repo, 'src/__snapshots__/app.test.ts.snap', 'exports[`a`] = `b`;\n');
    write(repo, 'public/vendor.min.js', 'var a=1;\n');
    write(repo, 'src/new.ts', 'export const added = true;\n');

    const shipped = await collectShippedDiff(repo);

    expect(shipped?.diff).toContain('+export const added = true;');
    expect(shipped?.diff).not.toContain('lockfileVersion');
    expect(shipped?.diff).not.toContain('exports[');
    expect(shipped?.diff).not.toContain('var a=1');
  });

  it('leaves lockfile noise out of the patch', async () => {
    const repo = createCheckout();
    write(repo, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    commit(repo, 'lock');
    git(repo, 'checkout', '-q', '-b', 'task');
    write(repo, 'pnpm-lock.yaml', 'lockfileVersion: 10\n');
    write(repo, 'src/app.ts', 'export const app = 2;\n');

    const shipped = await collectShippedDiff(repo);

    expect(shipped?.diff).toContain('src/app.ts');
    expect(shipped?.diff).not.toContain('lockfileVersion');
  });

  it('starts from the checkout of an existing pull-request branch, so removing earlier work shows as a change', async () => {
    const repo = createCheckout({ prBranch: true });
    git(repo, 'checkout', '-q', 'feature');
    fs.rmSync(path.join(repo, 'src/guard.ts'));
    commit(repo, 'remove guard');

    const shipped = await collectShippedDiff(repo);

    // Against the fork point the guard was added then removed: no net change.
    expect(shipped?.diff).toContain('-export const guard = true;');
    expect(shipped?.diff).not.toContain('app.ts');
  });

  it('falls back to the fork point once the default branch is merged in', async () => {
    const repo = createCheckout({ prBranch: true });
    const origin = path.join(path.dirname(repo), 'origin');
    write(origin, 'src/upstream.ts', 'export const upstream = true;\n');
    commit(origin, 'upstream work');
    git(repo, 'checkout', '-q', 'feature');
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'merge', '-q', '--no-edit', 'origin/main');
    write(repo, 'src/app.ts', 'export const app = 2;\n');

    const shipped = await collectShippedDiff(repo);

    expect(shipped?.diff).toContain('+export const app = 2;');
    expect(shipped?.diff).not.toContain('upstream');
  });

  it('labels each repository under a shared workspace root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-gate-root-'));
    tempDirs.push(root);

    for (const name of ['acme/api', 'acme/web']) {
      const source = createCheckout();
      const target = path.join(root, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(source, target);
      write(target, 'src/app.ts', `export const app = '${name}';\n`);
    }

    const shipped = await collectShippedDiff(root);

    expect(shipped?.diff).toContain('# repository: acme/api');
    expect(shipped?.diff).toContain('# repository: acme/web');
  });

  it('changes its key when the diff changes', async () => {
    const repo = createCheckout();
    write(repo, 'src/app.ts', 'export const app = 2;\n');
    const first = await collectShippedDiff(repo);
    write(repo, 'src/app.ts', 'export const app = 3;\n');
    const second = await collectShippedDiff(repo);

    expect(first?.key).not.toBe(second?.key);
  });
});

describe('clipDiffByFile', () => {
  it('clips the largest patches first and keeps every file represented', () => {
    const small = 'diff --git a/small.ts b/small.ts\n+small\n';
    const large = `diff --git a/large.ts b/large.ts\n${'+line\n'.repeat(500)}`;

    const clipped = clipDiffByFile(`${small}${large}`, 400);

    expect(clipped.truncated).toBe(true);
    expect(clipped.diff.length).toBeLessThanOrEqual(400);
    expect(clipped.diff).toContain(small);
    expect(clipped.diff).toContain('diff --git a/large.ts');
    expect(clipped.diff).toContain('rest of this patch clipped');
  });

  it('returns a diff that fits untouched', () => {
    expect(clipDiffByFile('diff --git a/a b/a\n+x\n', 1_000)).toEqual({
      diff: 'diff --git a/a b/a\n+x\n',
      truncated: false,
    });
  });
});

describe('isCompletionGateEligible', () => {
  const env = {
    ROOMOTE_COMPLETION_GATE: 'true',
    ROOMOTE_CLOUD_TOKEN: 'token',
    ROOMOTE_PLATFORM_API_URL: 'http://api.test',
    ROOMOTE_TASK_RUN_ID: '42',
  };

  it('requires the platform flag and credentials, and excludes reviews and automations', () => {
    expect(isCompletionGateEligible(env)).toBe(true);
    expect(isCompletionGateEligible(undefined)).toBe(false);
    expect(
      isCompletionGateEligible({ ...env, ROOMOTE_COMPLETION_GATE: 'false' }),
    ).toBe(false);
    expect(isCompletionGateEligible({ ...env, ROOMOTE_CLOUD_TOKEN: '' })).toBe(
      false,
    );
    expect(
      isCompletionGateEligible({ ...env, ROOMOTE_AUTOMATION_TASK: 'true' }),
    ).toBe(false);
    expect(
      isCompletionGateEligible({
        ...env,
        ROOMOTE_TASK_TYPE: 'github_pr_review',
      }),
    ).toBe(false);
  });
});

describe('isLikelySourceMutatingCommand', () => {
  it.each([
    "sed -i 's/guard/check/' src/guard.ts",
    "sed -i '' -e 's/a/b/' src/guard.ts",
    "perl -pi -e 's/a/b/' src/guard.ts",
    'git checkout -- src/guard.ts',
    'git checkout origin/main -- src/guard.ts',
    'git checkout .',
    'git reset --hard origin/main',
    'git restore src/guard.ts',
    'git stash pop',
    'git merge origin/main',
    'git apply /tmp/fix.patch',
    'patch -p1 < /tmp/fix.patch',
    'echo "export const guard = false;" > src/guard.ts',
    'cat /tmp/new.ts >> src/guard.ts',
    'node gen.js | tee src/generated.ts',
  ])('treats %s as an edit', (command) => {
    expect(isLikelySourceMutatingCommand(command)).toBe(true);
  });

  it.each([
    'pnpm vitest run src/guard.test.ts',
    'pnpm vitest run 2>&1 | tail -20',
    'pnpm check-types > /tmp/types.log 2>&1',
    'pnpm lint >/dev/null',
    'pnpm format',
    'git status --short',
    'git diff --stat',
    'git checkout -b fix/remove-guard',
    'git checkout feature/existing-pr',
    'git reset HEAD -- src/unexpected.ts',
    'git reset',
    'git restore --staged src/unexpected.ts',
    'git add -A && git commit -m "Remove the guard"',
    'git push origin HEAD',
    'gh pr edit 12 --body-file /tmp/pr-body.md',
    "grep -rn 'guard' src | head",
    'node -e "console.log(1 > 0)"',
  ])('leaves a validation run standing after %s', (command) => {
    expect(isLikelySourceMutatingCommand(command)).toBe(false);
  });
});

describe('buildCompletionGateReminder', () => {
  it('names each flagged point and tells the agent the check can be wrong', () => {
    const reminder = buildCompletionGateReminder([
      { id: 'reportOverclaims', probability: 0.9 },
      { id: 'leftoverArtifacts', probability: 0.88 },
    ]);

    expect(reminder).toContain(
      'Your report describes a code change that the diff does not contain.',
    );
    expect(reminder).toContain('debug logging');
    expect(reminder).toContain('can be wrong');
    expect(reminder).not.toContain('0.9');
  });
});
