import { describe, expect, it } from 'vitest';

import {
  buildDockerSandboxServerUrl,
  processListIncludesDockerWorkerRun,
  resolveDockerWorkerOwnershipTargetFromLookup,
  shouldAutoRemoveDockerWorkerContainer,
  toContainerReachableUrl,
} from '../spawn-docker-worker';

describe('processListIncludesDockerWorkerRun', () => {
  it('matches the shell launcher command while the Docker worker is starting', () => {
    expect(
      processListIncludesDockerWorkerRun(
        [
          'COMMAND',
          'bash -lc worker run 12 > /proc/1/fd/1 2> /proc/1/fd/2',
        ].join('\n'),
        12,
      ),
    ).toBe(true);
  });

  it('matches the resolved Node worker process after the launcher execs', () => {
    expect(
      processListIncludesDockerWorkerRun(
        [
          'COMMAND',
          '/opt/mise/installs/node/22.17.1/bin/node --no-opt -r /proc/.reset /sandbox/worker/dist/worker.js run 12',
        ].join('\n'),
        12,
      ),
    ).toBe(true);
  });

  it('does not match other task runs', () => {
    expect(
      processListIncludesDockerWorkerRun(
        '/sandbox/worker/dist/worker.js run 13',
        12,
      ),
    ).toBe(false);
  });
});

describe('buildDockerSandboxServerUrl', () => {
  it('builds a preview-proxy sandbox server URL for networked Docker workers', () => {
    expect(
      buildDockerSandboxServerUrl({
        network: 'roomote_default',
        taskId: 'task123456789',
        previewProxyBaseUrl: 'https://preview.roomote.example.com',
      }),
    ).toBe('https://task123456789-sandbox-server.preview.roomote.example.com');
  });

  it('keeps local Docker workers on their direct published URL path', () => {
    expect(
      buildDockerSandboxServerUrl({
        taskId: 'task123456789',
        previewProxyBaseUrl: 'https://preview.roomote.example.com',
      }),
    ).toBeUndefined();
  });
});

describe('toContainerReachableUrl', () => {
  it('rewrites localhost URLs for Docker without adding a trailing slash', () => {
    expect(toContainerReachableUrl('http://localhost:13001')).toBe(
      'http://host.docker.internal:13001',
    );
    expect(toContainerReachableUrl('http://127.0.0.1:13000/')).toBe(
      'http://host.docker.internal:13000',
    );
  });

  it('trims trailing slashes from non-localhost URLs', () => {
    expect(toContainerReachableUrl('https://roomote.example.com/')).toBe(
      'https://roomote.example.com',
    );
  });
});

describe('shouldAutoRemoveDockerWorkerContainer', () => {
  it('reaps containers in production and preview so token files do not linger', () => {
    expect(shouldAutoRemoveDockerWorkerContainer('production')).toBe(true);
    expect(shouldAutoRemoveDockerWorkerContainer('preview')).toBe(true);
  });

  it('preserves containers in development for post-mortem debugging', () => {
    expect(shouldAutoRemoveDockerWorkerContainer('development')).toBe(false);
  });
});

describe('resolveDockerWorkerOwnershipTargetFromLookup', () => {
  it('uses root ownership when the image user is unset', () => {
    expect(
      resolveDockerWorkerOwnershipTargetFromLookup({ imageUser: '' }),
    ).toBe('root:root');
  });

  it('preserves explicit user and group values from the image', () => {
    expect(
      resolveDockerWorkerOwnershipTargetFromLookup({
        imageUser: '1000:1001',
      }),
    ).toBe('1000:1001');
  });

  it('uses the same numeric uid and gid for numeric image users', () => {
    expect(
      resolveDockerWorkerOwnershipTargetFromLookup({ imageUser: '1000' }),
    ).toBe('1000:1000');
  });

  it('resolves named image users to their primary group name', () => {
    expect(
      resolveDockerWorkerOwnershipTargetFromLookup({
        imageUser: 'vercel-sandbox',
        passwdEntry:
          'vercel-sandbox:x:1001:1001::/home/vercel-sandbox:/bin/bash',
        groupEntry: 'vercel-sandbox:x:1001:',
      }),
    ).toBe('vercel-sandbox:vercel-sandbox');
  });

  it('falls back to the primary gid when the group lookup is unavailable', () => {
    expect(
      resolveDockerWorkerOwnershipTargetFromLookup({
        imageUser: 'ubuntu',
        passwdEntry: 'ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash',
      }),
    ).toBe('ubuntu:1000');
  });
});
