import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE_ROOT_MARKER = 'pnpm-workspace.yaml';

function findWorkspaceRoot(startDir = process.cwd()): string {
  let currentDir = path.resolve(startDir);

  while (true) {
    if (fs.existsSync(path.join(currentDir, WORKSPACE_ROOT_MARKER))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      throw new Error(`Unable to locate workspace root from: ${startDir}`);
    }

    currentDir = parentDir;
  }
}

export function resolveFromWorkspaceRoot(
  targetPath: string,
  startDir = process.cwd(),
): string {
  return path.resolve(findWorkspaceRoot(startDir), targetPath);
}
