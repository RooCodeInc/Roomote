import { fastAgentHumanFollowUpEventSchema } from './fast-agent';

describe('fastAgentHumanFollowUpEventSchema', () => {
  it('accepts an image-only human follow-up', () => {
    expect(
      fastAgentHumanFollowUpEventSchema.parse({
        type: 'human_follow_up',
        eventId: 'message-1',
        currentMessageId: 'message-1',
        userId: 'user-1',
        question: '',
        images: ['data:image/png;base64,aGVsbG8='],
      }),
    ).toMatchObject({
      question: '',
      images: ['data:image/png;base64,aGVsbG8='],
    });
  });

  it('rejects an empty follow-up without an attachment', () => {
    expect(() =>
      fastAgentHumanFollowUpEventSchema.parse({
        type: 'human_follow_up',
        eventId: 'message-1',
        currentMessageId: 'message-1',
        userId: 'user-1',
        question: '',
      }),
    ).toThrow('A human follow-up needs text or an attachment.');
  });
});
