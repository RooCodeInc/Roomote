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

  it('rewrites missing or unpullable worker image failures', () => {
    const error = `Docker command failed (docker run sleep):
Unable to find image 'roomote-worker:local' locally
docker: Error response from daemon: pull access denied for roomote-worker, repository does not exist or may require 'docker login'`;

    expect(getTaskRunErrorDisplayMessage(error)).toBe(
      "Roomote couldn't start because the worker image `roomote-worker:local` is missing or can't be pulled. Build or pull that image on the host (for local Docker, run the worker image build), or set DOCKER_WORKER_IMAGE to an image the host can access.",
    );
  });

  it('surfaces docker stderr instead of a raw command-failed dump', () => {
    const error = `Command failed: docker run -d --name roomote-worker-12 roomote-worker:local sleep infinity
permission denied while trying to connect to the Docker daemon socket`;

    expect(getTaskRunErrorDisplayMessage(error)).toBe(
      'Docker failed while starting the environment:\npermission denied while trying to connect to the Docker daemon socket',
    );
  });

  it('rewrites worker fetch-failed boot errors', () => {
    expect(
      getTaskRunErrorDisplayMessage('❌ Job sandbox-1 failed: fetch failed'),
    ).toBe(
      'Roomote reached the worker, but the sandbox failed while contacting the Roomote API (`fetch failed`). Check that the API is reachable from the worker network and that API/controller URLs are configured correctly.',
    );
  });
});
