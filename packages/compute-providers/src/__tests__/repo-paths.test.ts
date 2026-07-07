import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findWorkspaceRoot, resolveFromWorkspaceRoot } from '../repo-paths';

describe('repo-paths', () => {
  it('finds the workspace root by walking up to pnpm-workspace.yaml', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'roomote-root-'));
    const nestedDir = path.join(tempRoot, 'apps', 'controller');

    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'pnpm-workspace.yaml'), 'packages:\n');

    try {
      expect(findWorkspaceRoot(nestedDir)).toBe(tempRoot);
      expect(resolveFromWorkspaceRoot('releases', nestedDir)).toBe(
        path.join(tempRoot, 'releases'),
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
