import { db } from '../db';
import {
  slackFastIntegrationCalls,
  type SlackFastIntegrationCallStatus,
} from '../schema';
import { eq } from 'drizzle-orm';

export async function beginSlackFastIntegrationCall(input: {
  slackQuickAnswerId: string;
  userId: string;
  slackTeamId: string;
  slackChannel: string;
  slackThreadTs: string;
  slackMessageTs: string;
  integrationId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): Promise<{ id: string; startedAt: Date }> {
  const [created] = await db
    .insert(slackFastIntegrationCalls)
    .values({
      ...input,
      status: 'executing',
    })
    .returning({
      id: slackFastIntegrationCalls.id,
      startedAt: slackFastIntegrationCalls.startedAt,
    });

  if (!created) {
    throw new Error('Failed to create the fast integration call audit.');
  }

  return created;
}

export async function completeSlackFastIntegrationCall(input: {
  id: string;
  status: Exclude<SlackFastIntegrationCallStatus, 'executing'>;
  startedAt: Date;
  resultPreview?: string | null;
  error?: string | null;
}): Promise<void> {
  const completedAt = new Date();
  const [updated] = await db
    .update(slackFastIntegrationCalls)
    .set({
      status: input.status,
      resultPreview: input.resultPreview ?? null,
      error: input.error ?? null,
      completedAt,
      durationMs: Math.max(
        0,
        completedAt.getTime() - input.startedAt.getTime(),
      ),
      updatedAt: completedAt,
    })
    .where(eq(slackFastIntegrationCalls.id, input.id))
    .returning({ id: slackFastIntegrationCalls.id });

  if (!updated) {
    throw new Error('Fast integration call audit row was not found.');
  }
}
