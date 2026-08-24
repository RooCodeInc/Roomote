import {
  db,
  eq,
  fastAgentConversations,
  slackFastIntegrationCalls,
  userFactory,
  users,
} from '../../server';

import {
  beginSlackFastIntegrationCall,
  completeSlackFastIntegrationCall,
} from '../slack-fast-integration-calls';

describe('Slack fast integration call audit', () => {
  const createdUserIds: string[] = [];

  afterEach(async () => {
    for (const userId of createdUserIds.splice(0)) {
      await db.delete(users).where(eq(users.id, userId));
    }
  });

  it('persists the executing call before recording its terminal result', async () => {
    const user = await userFactory.create();
    createdUserIds.push(user.id);
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'slack',
        workspaceId: 'T123',
        conversationId: '100.1',
        currentReplyChannelId: 'C123',
        currentReplyThreadId: '100.1',
      })
      .returning({ id: fastAgentConversations.id });

    expect(conversation).toBeDefined();
    const started = await beginSlackFastIntegrationCall({
      fastAgentConversationId: conversation!.id,
      userId: user.id,
      slackTeamId: 'T123',
      slackChannel: 'C123',
      slackThreadTs: '100.1',
      slackMessageTs: '100.2',
      integrationId: 'notion',
      toolName: 'search',
      arguments: { query: 'roadmap' },
    });

    const [executing] = await db
      .select()
      .from(slackFastIntegrationCalls)
      .where(eq(slackFastIntegrationCalls.id, started.id));
    expect(executing).toMatchObject({
      fastAgentConversationId: conversation!.id,
      slackQuickAnswerId: null,
      userId: user.id,
      slackTeamId: 'T123',
      slackChannel: 'C123',
      slackThreadTs: '100.1',
      slackMessageTs: '100.2',
      integrationId: 'notion',
      toolName: 'search',
      arguments: { query: 'roadmap' },
      status: 'executing',
      completedAt: null,
    });

    await completeSlackFastIntegrationCall({
      id: started.id,
      status: 'succeeded',
      resultPreview: '{"results":["Q3 roadmap"]}',
      startedAt: started.startedAt,
    });

    const [completed] = await db
      .select()
      .from(slackFastIntegrationCalls)
      .where(eq(slackFastIntegrationCalls.id, started.id));
    expect(completed).toMatchObject({
      status: 'succeeded',
      resultPreview: '{"results":["Q3 roadmap"]}',
      error: null,
    });
    expect(completed?.completedAt).toBeInstanceOf(Date);
    expect(completed?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
