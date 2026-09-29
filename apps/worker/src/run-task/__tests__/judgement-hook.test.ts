import { execFile } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { installGitHook } from '@roo-code/judgement';

const exec = promisify(execFile);
let cwd: string;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'roomote-hook-'));
  env = {
    PATH: `${join(cwd, 'bin')}:${process.env.PATH}`,
    TRACE: join(cwd, 'trace'),
  };
  await mkdir(join(cwd, 'bin'));
  await mkdir(join(cwd, 'hooks'));
  const hook = await readFile(
    new URL('../../../../../.husky/pre-commit', import.meta.url),
    'utf8',
  );
  await writeFile(join(cwd, 'hooks/pre-commit'), `#!/bin/sh\n${hook}`, {
    mode: 0o755,
  });
  for (const [name, body] of Object.entries({
    npx: 'echo format >> "$TRACE"; exit "${FORMAT_EXIT:-0}"',
    pnpm: 'echo local >> "$TRACE"; exit "${LOCAL_EXIT:-0}"',
  })) {
    await writeFile(join(cwd, 'bin', name), `#!/bin/sh\n${body}\n`);
    await chmod(join(cwd, 'bin', name), 0o755);
  }
  await exec('git', ['init', '-q', '-b', 'test'], { cwd, env });
  await exec('git', ['config', 'core.hooksPath', 'hooks'], { cwd, env });
  await exec('git', ['config', 'user.name', 'Test'], { cwd, env });
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd, env });
  await writeFile(join(cwd, 'file.txt'), 'test');
  await exec('git', ['add', 'file.txt'], { cwd, env });
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
const commit = () => exec('git', ['commit', '-qm', 'test'], { cwd, env });
const trace = () => readFile(join(cwd, 'trace'), 'utf8');

it('runs developer inference once after formatting in a local checkout', async () => {
  await commit();
  expect(await trace()).toBe('format\nlocal\n');
});

it.each([true, false])(
  'runs only managed inference with the chained hook (proxy available: %s)',
  async (available) => {
    env.R_JUDGEMENT_MANAGED = '1';
    if (available) env.R_JUDGEMENT_GATEWAY_URL = 'http://127.0.0.1:1234/judge';
    // No run ID or credentials, just as in the user-facing task terminal.
    const managed = join(cwd, 'managed.sh');
    await writeFile(managed, '#!/bin/sh\necho managed >> "$TRACE"\n', {
      mode: 0o755,
    });
    await installGitHook({ cwd, command: [managed] });
    await commit();
    expect(await trace()).toBe('format\nmanaged\n');
  },
);

it('does not run inference after a formatting failure', async () => {
  env.FORMAT_EXIT = '7';
  await expect(commit()).rejects.toThrow();
  expect(await trace()).toBe('format\n');
});

it('blocks a local commit when Judgement reports a violation', async () => {
  env.LOCAL_EXIT = '1';
  await expect(commit()).rejects.toThrow();
  expect(await trace()).toBe('format\nlocal\n');
});
