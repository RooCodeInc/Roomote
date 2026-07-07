import type { AcpOtherUiMessage } from '../messages/acp/types';

import { getTaskParticipants } from './task-participants';

function createUserMessage(
  id: string,
  overrides: Partial<AcpOtherUiMessage> = {},
): AcpOtherUiMessage {
  return {
    id,
    ts: 1,
    role: 'user',
    kind: 'text',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.user_prompt',
    data: {},
    ...overrides,
  } satisfies AcpOtherUiMessage;
}

describe('getTaskParticipants', () => {
  it('returns distinct non-creator user participants in first-seen order', () => {
    const participants = getTaskParticipants(
      [
        createUserMessage('creator', {
          userId: 'creator-1',
          userName: 'Creator',
          userEmail: 'creator@example.com',
        }),
        createUserMessage('participant-1', {
          userId: 'participant-1',
          userName: 'Robin Reviewer',
          userEmail: 'robin@example.com',
          userImageUrl: 'https://example.com/robin.png',
        }),
        createUserMessage('assistant-message', { role: 'assistant' }),
        createUserMessage('participant-1-repeat', {
          userId: 'participant-1',
          userName: 'Robin Reviewer',
          userEmail: 'robin@example.com',
        }),
        createUserMessage('participant-2', {
          userId: 'participant-2',
          userName: 'Sam Support',
          userEmail: 'sam@example.com',
        }),
      ],
      {
        id: 'creator-1',
        name: 'Creator',
        email: 'creator@example.com',
      },
    );

    expect(participants).toEqual([
      {
        key: 'participant-1',
        userId: 'participant-1',
        name: 'Robin Reviewer',
        email: 'robin@example.com',
        imageUrl: 'https://example.com/robin.png',
      },
      {
        key: 'participant-2',
        userId: 'participant-2',
        name: 'Sam Support',
        email: 'sam@example.com',
        imageUrl: null,
      },
    ]);
  });

  it('falls back to email or name when userId is missing', () => {
    const participants = getTaskParticipants(
      [
        createUserMessage('participant-email', {
          userEmail: 'teammate@example.com',
          userName: 'Teammate',
        }),
        createUserMessage('participant-name', {
          userName: 'Anonymous Pair',
        }),
      ],
      null,
    );

    expect(participants).toEqual([
      {
        key: 'teammate@example.com',
        userId: null,
        name: 'Teammate',
        email: 'teammate@example.com',
        imageUrl: null,
      },
      {
        key: 'Anonymous Pair',
        userId: null,
        name: 'Anonymous Pair',
        email: null,
        imageUrl: null,
      },
    ]);
  });
});
