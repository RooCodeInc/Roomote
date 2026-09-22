import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { getDiffRiskHints } = vi.hoisted(() => ({
  getDiffRiskHints: vi.fn(),
}));

vi.mock('../tasks-api-client', () => ({ getDiffRiskHints }));

import { collectBranchDiff, handleGetDiffRiskHints } from '../diff-risk-hints';

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
}

function createCheckout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-risk-hints-'));
  tempDirs.push(root);
  const origin = path.join(root, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(origin, 'app.ts'), 'export const app = 1;\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'init');
  const checkout = path.join(root, 'checkout');
  git(root, 'clone', '-q', origin, checkout);
  return checkout;
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('diff risk hints tool', () => {
  beforeEach(() => {
    getDiffRiskHints.mockReset();
    process.env.ROOMOTE_TASK_RUN_ID = '42';
    process.env.ROOMOTE_CLOUD_TOKEN = 'run-token';
    process.env.ROOMOTE_PLATFORM_API_URL = 'https://platform.example.com';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('covers committed, uncommitted, and new files against the default branch', async () => {
    const repo = createCheckout();
    git(repo, 'checkout', '-q', '-b', 'task');
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const app = 2;\n');
    git(repo, 'commit', '-q', '-am', 'bump');
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const app = 3;\n');
    fs.writeFileSync(path.join(repo, 'new.ts'), 'export const added = true;\n');

    const diff = await collectBranchDiff(repo);

    expect(diff).toContain('-export const app = 1;');
    expect(diff).toContain('+export const app = 3;');
    expect(diff).toContain('+export const added = true;');
  });

  it('sends the branch diff and returns the hints', async () => {
    const repo = createCheckout();
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const app = 2;\n');
    getDiffRiskHints.mockResolvedValue({ available: true, text: 'hints' });

    const result = await handleGetDiffRiskHints({ repositoryPath: repo });

    expect(getDiffRiskHints).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'run-token' }),
      42,
      expect.stringContaining('+export const app = 2;'),
    );
    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      success: true,
      available: true,
      text: 'hints',
    });
  });

  it('does not call the platform when nothing changed', async () => {
    const repo = createCheckout();

    const result = await handleGetDiffRiskHints({ repositoryPath: repo });

    expect(getDiffRiskHints).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      available: false,
    });
  });
});
