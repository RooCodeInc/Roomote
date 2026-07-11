import { describe, expect, it } from 'vitest';

import {
  getBitbucketUserAccountKey,
  getBitbucketUsername,
} from '../getBitbucketAutomationTargets';

describe('getBitbucketAutomationTargets helpers', () => {
  it('prefers nickname for display username', () => {
    expect(
      getBitbucketUsername({
        nickname: 'nick',
        username: 'user',
        display_name: 'Display',
      }),
    ).toBe('nick');
  });

  it('normalizes account_id and uuid keys', () => {
    expect(
      getBitbucketUserAccountKey({
        account_id: 'ACCT-1',
      }),
    ).toBe('acct-1');

    expect(
      getBitbucketUserAccountKey({
        uuid: '{AbCd-Ef}',
      }),
    ).toBe('abcd-ef');
  });
});
