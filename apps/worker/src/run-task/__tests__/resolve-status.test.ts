import { CloudTaskStatus } from '@roomote/types';

import { resolveStatus } from '../resolve-status';

describe('resolveStatus', () => {
  it('returns the last canceled error message unchanged', () => {
    const result = resolveStatus({
      sessionId: 'task-1',
      lastMessageAt: undefined,
      lastActivityAt: undefined,
      taskFinishedAt: undefined,
      taskAbortedAt: Date.now(),
      clientDisconnectedAt: undefined,
      cancelTriggeredAt: undefined,
      lastErrorMessage:
        'unexpected status 401 Unauthorized: Incorrect API key provided: [redacted-api-key]',
      cancelInterval: undefined,
      slackMessageInterval: undefined,
      linearMessageInterval: undefined,
      githubTokenRefreshInterval: undefined,
    });

    expect(result.status).toBe(CloudTaskStatus.Canceled);
    expect(result.error).toBe(
      'unexpected status 401 Unauthorized: Incorrect API key provided: [redacted-api-key]',
    );
  });
});
