import { TaskPayloadKind } from '@roomote/types';

import { canLearnPersonalizationForRun } from '../updatePersonalization';

describe('personalization learning run authorization', () => {
  it.each([
    TaskPayloadKind.StandardTask,
    TaskPayloadKind.SlackAppMention,
    TaskPayloadKind.LinearAgentSession,
    TaskPayloadKind.SnapshotResume,
    TaskPayloadKind.GithubPrReview,
  ])('allows a trusted user actor on %s', (payloadKind) => {
    expect(
      canLearnPersonalizationForRun({
        actingUserId: 'current-user',
        initiatorKind: 'user',
        payloadKind,
      }),
    ).toBe(true);
  });

  it.each([
    {
      actingUserId: 'service-user',
      initiatorKind: 'automation',
      payloadKind: TaskPayloadKind.StandardTask,
    },
    {
      actingUserId: 'user-1',
      initiatorKind: 'user',
      payloadKind: TaskPayloadKind.Scan,
    },
    {
      actingUserId: null,
      initiatorKind: 'user',
      payloadKind: TaskPayloadKind.SnapshotResume,
    },
  ])('denies automation, maintenance, and actorless runs', (run) => {
    expect(canLearnPersonalizationForRun(run)).toBe(false);
  });
});
