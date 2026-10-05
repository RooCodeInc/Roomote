import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

const testFilePath = fileURLToPath(import.meta.url);
const testDir = path.dirname(testFilePath);
const repoRoot = path.resolve(testDir, '../../../../../');
const repoScriptPath = path.join(repoRoot, 'scripts/build-worker-release.sh');

describe('build-worker-release.sh', () => {
  let tempDir: string;
  let tempRepoRoot: string;
  let tempScriptPath: string;
  let outputDir: string;
  let fakeBinDir: string;
  let pnpmLogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-release-script-'));
    tempRepoRoot = path.join(tempDir, 'repo');
    tempScriptPath = path.join(tempRepoRoot, 'scripts/build-worker-release.sh');
    outputDir = path.join(tempDir, 'output');
    fakeBinDir = path.join(tempDir, 'bin');
    pnpmLogPath = path.join(tempDir, 'pnpm.log');

    fs.mkdirSync(path.dirname(tempScriptPath), { recursive: true });
    fs.mkdirSync(path.join(tempRepoRoot, 'apps/worker'), { recursive: true });
    fs.mkdirSync(
      path.join(
        tempRepoRoot,
        'packages/cloud-agents/src/server/workflows/skills/standard',
      ),
      { recursive: true },
    );
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(fakeBinDir, { recursive: true });

    fs.copyFileSync(repoScriptPath, tempScriptPath);
    fs.chmodSync(tempScriptPath, 0o755);
    fs.writeFileSync(
      path.join(tempRepoRoot, 'apps/worker/package.json'),
      JSON.stringify({ dependencies: { 'node-pty': '^1.0.0' } }),
    );
    // The script reads the pm2 pin from the worker Dockerfile's ARG.
    fs.writeFileSync(
      path.join(tempRepoRoot, 'apps/worker/Dockerfile'),
      'ARG PM2_VERSION=7.0.1\n',
    );
    fs.writeFileSync(
      path.join(fakeBinDir, 'pnpm'),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$PNPM_LOG"

if [[ "$1" == "--filter" && "$2" == "@roomote/worker" && "$3" == "build" ]]; then
  mkdir -p apps/worker/dist/skills/judgement/references
  printf 'worker bundle' > apps/worker/dist/worker.js
  printf 'judgement skill' > apps/worker/dist/skills/judgement/SKILL.md
  printf 'judgement guide' > apps/worker/dist/skills/judgement/references/agent-guide.md
  exit 0
fi

if [[ "$1" == "dlx" ]]; then
  printf 'unexpected sentry dlx invocation\\n' >> "$PNPM_LOG"
  exit 43
fi

printf 'unexpected pnpm invocation: %s\\n' "$*" >&2
exit 44
`,
    );
    fs.chmodSync(path.join(fakeBinDir, 'pnpm'), 0o755);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('ignores task SENTRY_AUTH_TOKEN values when building local archives', async () => {
    await execa(
      'bash',
      [tempScriptPath, 'local-dev', '--output-dir', outputDir],
      {
        cwd: tempRepoRoot,
        env: {
          ...process.env,
          BASH_ENV: '/dev/null',
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
          PNPM_LOG: pnpmLogPath,
          SENTRY_AUTH_TOKEN: 'task-sentry-token',
          SENTRY_ORG: '',
          SENTRY_PROJECT: '',
        },
      },
    );

    expect(
      fs.existsSync(path.join(outputDir, 'worker-vlocal-dev.tar.gz')),
    ).toBe(true);
    expect(fs.readFileSync(pnpmLogPath, 'utf8')).toBe(
      '--filter @roomote/worker build\n',
    );
    for (const [file, content] of [
      ['SKILL.md', 'judgement skill'],
      ['references/agent-guide.md', 'judgement guide'],
    ]) {
      const { stdout } = await execa('tar', [
        '-xOzf',
        path.join(outputDir, 'worker-vlocal-dev.tar.gz'),
        `worker-vlocal-dev/.packaged-skills/standard/judgement/${file}`,
      ]);
      expect(stdout).toBe(content);
    }
  });
});
