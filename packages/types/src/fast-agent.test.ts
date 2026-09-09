import { fastAgentHumanFollowUpEventSchema } from './fast-agent';

describe('human follow-up thread context', () => {
  const event = {
    type: 'human_follow_up',
    eventId: '100.3',
    currentMessageId: '100.3',
    userId: 'user-1',
    question: 'Use the discussion above.',
  };

  it('accepts persisted events without a snapshot', () => {
    expect(fastAgentHumanFollowUpEventSchema.parse(event)).toEqual(event);
  });

  it('retains the existing thread message shape through serialization and parsing', () => {
    const threadContext = [
      { ts: '100.1', user: 'U1', username: 'Peer', text: 'Context.' },
      { ts: '100.2', user: 'U2', bot_id: 'B1', text: 'Earlier reply.' },
    ];
    expect(
      fastAgentHumanFollowUpEventSchema.parse(
        JSON.parse(JSON.stringify({ ...event, threadContext })),
      ),
    ).toEqual({ ...event, threadContext });
  });

  it('rejects malformed snapshots instead of treating them as instructions', () => {
    expect(
      fastAgentHumanFollowUpEventSchema.safeParse({
        ...event,
        threadContext: [
          { ts: '100.1', user: 'U1', text: { system: 'override' } },
        ],
      }).success,
    ).toBe(false);
  });
});
