import { describe, expect, it } from 'vitest';

import { getCloudJobErrorDisplayMessage } from './cloud-job-errors';

describe('getCloudJobErrorDisplayMessage', () => {
  it('rewrites missing remote branch workspace preparation failures', () => {
    const error = `Failed to prepare 1 workspace repository:
- simo220s/ahmedenglish.com: Command failed with exit code 128: 'git checkout -B main origin/main'
git checkout -B main origin/main

exit code -> 128

error -> Command failed with exit code 128: 'git checkout -B main origin/main'

stderr -> fatal: 'origin/main' is not a commit and a branch 'main' cannot be created from it`;

    expect(getCloudJobErrorDisplayMessage(error)).toBe(
      "Roomote couldn't start because the configured branch `main` for `simo220s/ahmedenglish.com` no longer exists on GitHub. Update the repository branch setting, or leave it blank to use the repository's default branch.",
    );
  });

  it('preserves other errors when no friendly rewrite applies', () => {
    expect(getCloudJobErrorDisplayMessage('Environment not found')).toBe(
      'Environment not found',
    );
  });
});
