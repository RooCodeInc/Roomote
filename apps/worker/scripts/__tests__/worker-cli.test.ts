import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

const workerDir = fileURLToPath(new URL('../..', import.meta.url));
const workerScript = path.join(workerDir, 'scripts/worker.ts');

describe('worker CLI', () => {
  it('lists services without requiring the full app environment', async () => {
    const result = await execa('tsx', [workerScript, 'services'], {
      cwd: workerDir,
      preferLocal: true,
      extendEnv: false,
      env: {
        HOME: process.env.HOME ?? '',
        PATH: process.env.PATH ?? '',
        PNPM_HOME: process.env.PNPM_HOME ?? '',
        NODE_ENV: 'development',
      },
    });

    expect(result.stdout).toContain('Available services');
    expect(result.stdout).toContain('redis7');
    expect(result.stdout).toContain('postgres17');
  });
});
