const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  getUserPersonalizationRuntimeContext: mocks.getContext,
}));

import { TaskPayloadKind } from '@roomote/types';

import {
  appendPrivateTaskPersonalization,
  getPrivateTaskPersonalizationInstructions,
} from './task-personalization';

describe('private task personalization injection', () => {
  beforeEach(() => {
    mocks.getContext.mockReset();
    mocks.getContext.mockResolvedValue({
      displayName: 'Ada',
      instructions: 'Lead with a recommendation.',
      learnFromConversations: true,
    });
  });

  it.each([
    TaskPayloadKind.StandardTask,
    TaskPayloadKind.SlackAppMention,
    TaskPayloadKind.SnapshotResume,
    TaskPayloadKind.GithubPrReview,
  ])('loads the acting user for a human-owned %s run', async (payloadKind) => {
    const instructions = await getPrivateTaskPersonalizationInstructions({
      actingUserId: 'current-speaker',
      initiatorKind: 'user',
      payloadKind,
    });

    expect(mocks.getContext).toHaveBeenCalledWith('current-speaker');
    expect(instructions).toContain('Lead with a recommendation.');
  });

  it.each([
    {
      actingUserId: 'service-user',
      initiatorKind: 'automation' as const,
      payloadKind: TaskPayloadKind.StandardTask,
    },
    {
      actingUserId: 'user-1',
      initiatorKind: 'user' as const,
      payloadKind: TaskPayloadKind.Scan,
    },
    {
      actingUserId: null,
      initiatorKind: 'user' as const,
      payloadKind: TaskPayloadKind.StandardTask,
    },
  ])('does not inject for automation or actorless runs', async (input) => {
    await expect(
      getPrivateTaskPersonalizationInstructions(input),
    ).resolves.toBe('');
    expect(mocks.getContext).not.toHaveBeenCalled();
  });

  it('appends private context without changing the persistable public value', () => {
    const publicInstructions = 'Public harness guidance';
    const result = appendPrivateTaskPersonalization(
      publicInstructions,
      '<user_personalization>private</user_personalization>',
    );

    expect(publicInstructions).toBe('Public harness guidance');
    expect(result).toContain(publicInstructions);
    expect(result).toContain(
      '<user_personalization>private</user_personalization>',
    );
  });
});
