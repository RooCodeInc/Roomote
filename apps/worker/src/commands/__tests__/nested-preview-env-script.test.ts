import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const scriptPath = './.roomote/scripts/with-nested-preview-env.sh';

function readEnvironment(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe('with-nested-preview-env.sh', () => {
  it('runs the command unchanged when the outer preview host is unavailable', () => {
    const result = spawnSync(scriptPath, ['/usr/bin/env'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });

    expect(result.status, result.stderr).toBe(0);
    const environment = readEnvironment(result.stdout);
    expect(environment.PREVIEW_PROXY_BASE_URL).toBeUndefined();
    expect(environment.PREVIEW_PROXY_SUBDOMAIN_SUFFIX).toBeUndefined();
    expect(environment.PREVIEW_DOMAINS).toBeUndefined();
    expect(environment.NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL).toBeUndefined();
    expect(
      environment.NEXT_PUBLIC_PREVIEW_PROXY_SUBDOMAIN_SUFFIX,
    ).toBeUndefined();
  });

  it('derives nested preview settings from the wildcard preview named port', () => {
    const result = spawnSync(scriptPath, ['/usr/bin/env'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        ROOMOTE_PREVIEW_HOST:
          'https://outer-task-preview.preview.roomote.example.com',
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readEnvironment(result.stdout)).toMatchObject({
      PREVIEW_PROXY_BASE_URL: 'https://preview.roomote.example.com',
      PREVIEW_PROXY_SUBDOMAIN_SUFFIX: 'outer-task-preview',
      PREVIEW_DOMAINS: 'preview.roomote.example.com',
      NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL: 'https://preview.roomote.example.com',
      NEXT_PUBLIC_PREVIEW_PROXY_SUBDOMAIN_SUFFIX: 'outer-task-preview',
    });
  });
});
