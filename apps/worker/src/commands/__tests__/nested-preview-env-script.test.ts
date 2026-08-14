import { spawnSync } from 'node:child_process';
import path from 'node:path';

const scriptPath = path.resolve(
  __dirname,
  '../../../../../.roomote/scripts/with-nested-preview-env.sh',
);

const printPreviewEnv = [
  'printf "%s\\n"',
  '"${PREVIEW_PROXY_BASE_URL-unset}"',
  '"${PREVIEW_PROXY_SUBDOMAIN_SUFFIX-unset}"',
  '"${PREVIEW_DOMAINS-unset}"',
  '"${NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL-unset}"',
  '"${NEXT_PUBLIC_PREVIEW_PROXY_SUBDOMAIN_SUFFIX-unset}"',
].join(' ');

function runWrapper(env: Record<string, string> = {}) {
  return spawnSync(
    '/bin/bash',
    [scriptPath, '/bin/bash', '-c', printPreviewEnv],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        ...env,
      },
    },
  );
}

describe('with-nested-preview-env.sh', () => {
  it('runs the command unchanged when the outer preview host is unavailable', () => {
    const result = runWrapper();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'unset',
      'unset',
      'unset',
      'unset',
      'unset',
    ]);
  });

  it('derives nested preview settings from the wildcard preview named port', () => {
    const result = runWrapper({
      ROOMOTE_PREVIEW_HOST:
        'https://outer-task-preview.preview.roomote.example.com',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'https://preview.roomote.example.com',
      'outer-task-preview',
      'preview.roomote.example.com',
      'https://preview.roomote.example.com',
      'outer-task-preview',
    ]);
  });
});
