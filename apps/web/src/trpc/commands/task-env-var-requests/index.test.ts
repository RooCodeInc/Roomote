import {
  db,
  eq,
  runFactory,
  taskFactory,
  taskMessages,
  userFactory,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

import { markTaskEnvVarRequestFulfilledCommand } from './index';

function buildAdminAuth(userId: string): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId,
    name: 'Admin',
    primaryEmail: 'admin@example.com',
    isAdmin: true,
    featureFlags: {} as UserAuthSuccess['featureFlags'],
    anonymousAnalyticsEnabled: false,
    cloudEnabled: false,
    cookieConsentedAt: null,
    resource: {
      username: null,
      fullName: 'Admin',
      firstName: 'Admin',
      lastName: null,
      primaryEmailAddress: {
        id: 'email-1',
        emailAddress: 'admin@example.com',
      },
      emailAddresses: [{ id: 'email-1', emailAddress: 'admin@example.com' }],
      imageUrl: '',
      createdAt: null,
    },
  };
}

const CLIENT_MESSAGE_ID = 'env-var-request-fulfilled:test-marker';

describe('markTaskEnvVarRequestFulfilledCommand', () => {
  it('persists a durable hidden fulfillment envelope for the active run', async () => {
    const user = await userFactory.create();
    const task = await taskFactory.create({ workflow: 'standard' });
    const run = await runFactory.create({
      taskId: task.id,
      payloadKind: TaskPayloadKind.StandardTask,
    });

    const result = await markTaskEnvVarRequestFulfilledCommand(
      buildAdminAuth(user.id),
      { taskId: task.id, clientMessageId: CLIENT_MESSAGE_ID },
    );

    expect(result).toEqual({ recorded: true });

    const messages = await db.query.taskMessages.findMany({
      where: eq(taskMessages.runId, run.id),
    });
    const fulfillment = messages.find(
      (message) =>
        (message.payload as { clientMessageId?: string } | null)
          ?.clientMessageId === CLIENT_MESSAGE_ID,
    );

    expect(fulfillment).toBeDefined();
  });

  it('returns recorded:false when the task has no run', async () => {
    const result = await markTaskEnvVarRequestFulfilledCommand(
      buildAdminAuth('user-fulfill-2'),
      {
        taskId: 'task-without-a-run',
        clientMessageId: CLIENT_MESSAGE_ID,
      },
    );

    expect(result).toEqual({ recorded: false });
  });
});
