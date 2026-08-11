import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';

import { appRouter } from '../../routers';
import type { Context } from '../../trpc';

async function createRepository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roomote-git-inspect-'));
  const remote = path.join(root, 'remote.git');
  const workspace = path.join(root, 'workspace');
  await execa('git', ['init', '--bare', remote]);
  await execa('git', ['clone', remote, workspace]);
  await execa('git', ['config', 'user.email', 'roomote@example.test'], {
    cwd: workspace,
  });
  await execa('git', ['config', 'user.name', 'Roomote Test'], {
    cwd: workspace,
  });
  await fs.writeFile(path.join(workspace, 'README.md'), 'hello\n');
  await execa('git', ['add', 'README.md'], { cwd: workspace });
  await execa('git', ['commit', '-m', 'Initial commit'], { cwd: workspace });
  await execa('git', ['push', '--set-upstream', 'origin', 'HEAD'], {
    cwd: workspace,
  });
  return { root, workspace };
}

function caller(workingDirectory: string) {
  return appRouter.createCaller({
    workingDirectory,
    harness: {} as Context['harness'],
    auth: null,
  });
}

describe('inspectWorkspaceGit', () => {
  it('reports clean pushed state and later detects a dirty file', async () => {
    const { root, workspace } = await createRepository();
    try {
      const clean = await caller(workspace).commands.inspectWorkspaceGit();
      expect(clean.repositories).toMatchObject([
        { repository: '.', ahead: 0, dirtyPaths: [] },
      ]);

      await fs.writeFile(path.join(workspace, 'README.md'), 'changed\n');
      const dirty = await caller(workspace).commands.inspectWorkspaceGit();
      expect(dirty.repositories[0]?.dirtyPaths).toEqual(['README.md']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
