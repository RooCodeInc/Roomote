import { describe, expect, it } from 'vitest';

import { getTaskRunErrorDisplayMessage } from './task-run-errors';

describe('getTaskRunErrorDisplayMessage', () => {
  it('rewrites missing remote branch workspace preparation failures', () => {
    const error = `Failed to prepare 1 workspace repository:
- simo220s/ahmedenglish.com: Command failed with exit code 128: 'git checkout -B main origin/main'
git checkout -B main origin/main

exit code -> 128

error -> Command failed with exit code 128: 'git checkout -B main origin/main'

stderr -> fatal: 'origin/main' is not a commit and a branch 'main' cannot be created from it`;

    expect(getTaskRunErrorDisplayMessage(error)).toBe(
      "Roomote couldn't start because the configured branch `main` for `simo220s/ahmedenglish.com` no longer exists on GitHub. Update the repository branch setting, or leave it blank to use the repository's default branch.",
    );
  });

  it('preserves other errors when no friendly rewrite applies', () => {
    expect(getTaskRunErrorDisplayMessage('Environment not found')).toBe(
      'Environment not found',
    );
  });

  it('explains missing Docker worker images instead of only showing docker run', () => {
    const error = `Failed to run docker run.

Unable to find image 'roomote-worker:local' locally
docker: Error response from daemon: pull access denied for roomote-worker, repository does not exist or may require 'docker login'

command:
docker run -d --name roomote-worker-12 roomote-worker:local sleep infinity`;

    const display = getTaskRunErrorDisplayMessage(error);

    expect(display).toContain("couldn't find or pull the worker image");
    expect(display).toContain('pull access denied for roomote-worker');
    expect(display).not.toMatch(/^docker run -d/);
  });

  it('explains Docker daemon connectivity failures', () => {
    const error = `Failed to run docker run.

Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?

command:
docker run -d roomote-worker:local`;

    expect(getTaskRunErrorDisplayMessage(error)).toContain(
      "couldn't reach the Docker daemon",
    );
  });

  it('explains worker start timeouts and keeps the docker process list', () => {
    const error = `Docker worker for task run #9 did not start within 60s.

The container stayed running, but the Roomote worker process never appeared. Check that the local worker image and release archive are available, and inspect container logs for fetch/start failures.

Docker process list:
PID   COMMAND
1     sleep infinity`;

    const display = getTaskRunErrorDisplayMessage(error);

    expect(display).toContain('did not come up in time');
    expect(display).toContain('Docker process list:');
    expect(display).toContain('sleep infinity');
  });

  it('explains worker fetch failures seen in container logs', () => {
    const error = `Docker worker container exited before task run #3 started.

Recent Docker logs:
❌ Job <unknown> failed: fetch failed`;

    const display = getTaskRunErrorDisplayMessage(error);

    expect(display).toContain('fetch failed');
    expect(display).toContain('host.docker.internal');
  });
});
