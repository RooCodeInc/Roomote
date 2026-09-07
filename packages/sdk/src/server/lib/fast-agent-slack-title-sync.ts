import {
  and,
  db,
  eq,
  fastAgentConversations,
  slackInstallations,
} from '@roomote/db/server';
import {
  SlackNotifier,
  syncSlackAgentSessionTitleBestEffort,
} from '@roomote/slack';

export async function syncFastAgentSlackTitleBestEffort({
  conversationId,
}: {
  conversationId: string;
}): Promise<void> {
  try {
    const conversation = await db.query.fastAgentConversations.findFirst({
      where: eq(fastAgentConversations.id, conversationId),
      columns: {
        surface: true,
        workspaceId: true,
        conversationId: true,
        currentReplyChannelId: true,
        currentReplyThreadId: true,
        title: true,
      },
    });
    if (
      !conversation ||
      conversation.surface !== 'slack' ||
      !conversation.currentReplyChannelId ||
      !conversation.title?.trim()
    ) {
      return;
    }

    const installation = await db.query.slackInstallations.findFirst({
      where: and(
        eq(slackInstallations.isActive, true),
        eq(slackInstallations.teamId, conversation.workspaceId),
      ),
      columns: { botAccessToken: true },
    });
    if (!installation?.botAccessToken) return;

    await syncSlackAgentSessionTitleBestEffort({
      slack: new SlackNotifier(installation.botAccessToken),
      workspaceId: conversation.workspaceId,
      channel: conversation.currentReplyChannelId,
      threadTs:
        conversation.currentReplyThreadId ?? conversation.conversationId,
      title: conversation.title,
      resolveTitle: async () =>
        (
          await db.query.fastAgentConversations.findFirst({
            where: eq(fastAgentConversations.id, conversationId),
            columns: { title: true },
          })
        )?.title,
    });
  } catch (error) {
    console.warn(
      `[syncFastAgentSlackTitle] Failed for conversation=${conversationId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
