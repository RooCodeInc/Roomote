import {
  automations,
  db,
  runFactory,
  taskFactory,
  userFactory,
} from '@roomote/db/server';
import { TaskPayloadKind } from '@roomote/types';

import { buildCreatorFilterValue } from '@/lib/task-creator-filter';

import { getTasks, searchTasks } from './tasks';

describe('searchTasks', () => {
  it('returns only the current users tasks by default', async () => {
    const me = await userFactory.create({});
    const other = await userFactory.create({});

    const myTask = await taskFactory.create({
      title: 'Mine: fix sidebar',
      initiatorUserId: me.id,
      activityAt: 2_000,
      timestamp: 2_000,
    });
    await runFactory.create({
      taskId: myTask.id,
      payloadKind: TaskPayloadKind.StandardTask,
    });

    const theirTask = await taskFactory.create({
      title: 'Theirs: infra flip',
      initiatorUserId: other.id,
      activityAt: 3_000,
      timestamp: 3_000,
    });
    await runFactory.create({
      taskId: theirTask.id,
      payloadKind: TaskPayloadKind.StandardTask,
    });

    const results = await searchTasks({ userId: me.id, limit: 20 });

    expect(results.map((task) => task.id)).toEqual([myTask.id]);
  });

  it('only includes explicit includeIds initiated by the current user', async () => {
    const me = await userFactory.create({});
    const other = await userFactory.create({});

    const myRecentTask = await taskFactory.create({
      title: 'Recent task',
      initiatorUserId: me.id,
      activityAt: 5_000,
      timestamp: 5_000,
    });
    await runFactory.create({
      taskId: myRecentTask.id,
      payloadKind: TaskPayloadKind.StandardTask,
    });

    const myIncludedTask = await taskFactory.create({
      title: 'Pinned task',
      initiatorUserId: me.id,
      activityAt: 3_000,
      timestamp: 3_000,
    });
    await runFactory.create({
      taskId: myIncludedTask.id,
      payloadKind: TaskPayloadKind.StandardTask,
    });

    const theirTask = await taskFactory.create({
      title: 'Shared review',
      initiatorUserId: other.id,
      activityAt: 4_000,
      timestamp: 4_000,
    });
    await runFactory.create({
      taskId: theirTask.id,
      payloadKind: TaskPayloadKind.StandardTask,
    });

    const results = await searchTasks({
      userId: me.id,
      limit: 1,
      includeIds: [myIncludedTask.id, theirTask.id],
    });

    expect(results.map((task) => task.id)).toEqual([
      myRecentTask.id,
      myIncludedTask.id,
    ]);
  });

  it('filters title ILIKE search to the current user', async () => {
    const me = await userFactory.create({});
    const other = await userFactory.create({});

    const myTask = await taskFactory.create({
      title: 'purple banana widget',
      initiatorUserId: me.id,
      activityAt: 5_000,
      timestamp: 5_000,
    });
    await runFactory.create({
      taskId: myTask.id,
      payloadKind: TaskPayloadKind.StandardTask,
    });

    const theirTask = await taskFactory.create({
      title: 'purple banana sibling',
      initiatorUserId: other.id,
      activityAt: 6_000,
      timestamp: 6_000,
    });
    await runFactory.create({
      taskId: theirTask.id,
      payloadKind: TaskPayloadKind.StandardTask,
    });

    const results = await searchTasks({
      userId: me.id,
      query: 'purple banana',
      limit: 20,
    });

    expect(results.map((task) => task.id)).toEqual([myTask.id]);
  });
});

describe('getTasks', () => {
  it('scopes custom automation filters to one actor id', async () => {
    await db
      .insert(automations)
      .values({ key: 'custom_automation', internal: true })
      .onConflictDoNothing();

    const selectedTask = await taskFactory.create({
      title: 'Selected custom automation',
      initiatorKind: 'automation',
      initiatorUserId: null,
      initiatorAutomation: 'custom_automation',
      actorExternalId: 'automation-1',
      actorDisplayName: 'Weekly flaky-test scan',
      activityAt: 2_000,
      timestamp: 2_000,
    });
    await runFactory.create({
      taskId: selectedTask.id,
      payloadKind: TaskPayloadKind.StandardTask,
    });
    const otherTask = await taskFactory.create({
      title: 'Other custom automation',
      initiatorKind: 'automation',
      initiatorUserId: null,
      initiatorAutomation: 'custom_automation',
      actorExternalId: 'automation-2',
      actorDisplayName: 'Daily dependency scan',
      activityAt: 3_000,
      timestamp: 3_000,
    });
    await runFactory.create({
      taskId: otherTask.id,
      payloadKind: TaskPayloadKind.StandardTask,
    });
    const filterValue = buildCreatorFilterValue({
      initiatorKind: 'automation',
      initiatorUserId: null,
      initiatorAutomation: 'custom_automation',
      actorExternalId: 'automation-1',
    });

    const result = await getTasks({
      userId: 'unused',
      filters: [
        {
          type: 'userId',
          value: filterValue!,
          label: 'Weekly flaky-test scan',
        },
      ],
    });

    expect(result.tasks.map((task) => task.id)).toEqual([selectedTask.id]);
  });
});
