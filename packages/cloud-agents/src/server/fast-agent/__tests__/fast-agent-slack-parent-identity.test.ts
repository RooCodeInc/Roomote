import { db, eq, userFactory, users } from '@roomote/db/server';

const mocks = vi.hoisted(() => ({ enqueueTask: vi.fn() }));

vi.mock('../../task-run-queue', () => ({ enqueueTask: mocks.enqueueTask }));
vi.mock('../../task-url', () => ({
  getTaskUrl: () => 'https://roomote.example/task/task-1',
}));

import { fastAgentConversationRepository } from '../fast-agent-conversation-repository';
import { createFastAgentSlackTaskLauncher } from '../fast-agent-task-launcher';

it('preserves the logical Slack parent identity when delegating from a bound automation thread', async () => {
  const user = await userFactory.create();
  try {
    const conversation = {
      surface: 'slack' as const,
      workspaceId: `team-${crypto.randomUUID()}`,
      conversationId: `${crypto.randomUUID()}:2026-09-05T06:32:07.044Z`,
      replyTarget: { channelId: 'channel-test', threadId: '100.001' },
    };
    const original = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation,
    });
    const resumed = await fastAgentConversationRepository.getOrCreate({
      userId: user.id,
      conversation: {
        ...conversation,
        conversationId: conversation.replyTarget.threadId,
      },
    });
    expect(resumed.id).toBe(original.id);
    expect(resumed.conversation).toEqual(conversation);
    expect(
      await fastAgentConversationRepository.findById({
        id: resumed.id,
        fallbackConversation: resumed.conversation,
      }),
    ).toMatchObject({ id: original.id });

    mocks.enqueueTask.mockResolvedValue({ taskId: 'task-1' });
    const launch = createFastAgentSlackTaskLauncher({
      userId: user.id,
      teamId: conversation.workspaceId,
      channelId: conversation.replyTarget.channelId,
      threadTs: conversation.replyTarget.threadId,
    });
    await launch({
      prompt: 'Investigate the reported issue',
      environmentId: null,
      parentSessionId: resumed.id,
      postKickoff: async () => {},
    });
    const parent =
      mocks.enqueueTask.mock.calls[0]![0].task.payload.fastAgentParent;
    expect(parent.sessionId).toBe(original.id);

    // The SDK parent-event reader performs this exact identity-checked lookup.
    expect(
      await fastAgentConversationRepository.findById({
        id: parent.sessionId,
        fallbackConversation: parent.conversation,
      }),
    ).toMatchObject({ id: original.id });
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
  }
});
