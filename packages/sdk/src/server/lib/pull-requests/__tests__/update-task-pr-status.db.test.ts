import {
  db,
  eq,
  openTaskResolutionOnCloseout,
  taskFactory,
  taskPullRequests,
  tasks,
} from '@roomote/db/server';

import { updateTaskPrStatus } from '../update-task-pr-status';

describe('updateTaskPrStatus database behavior', () => {
  const taskIds: string[] = [];

  afterEach(async () => {
    while (taskIds.length > 0) {
      await db.delete(tasks).where(eq(tasks.id, taskIds.pop()!));
    }
  });

  async function createTaskWithPullRequests(
    statuses: Array<'open' | 'draft' | 'merged' | 'closed'>,
  ) {
    const task = await taskFactory.create({ requestedWorkKind: 'implement' });
    taskIds.push(task.id);
    const repository = `owner/pr-status-${task.id}`;
    await db.insert(taskPullRequests).values(
      statuses.map((status, index) => ({
        taskId: task.id,
        sourceControlProvider: 'github' as const,
        repository,
        prNumber: index + 1,
        prUrl: `https://github.com/${repository}/pull/${index + 1}`,
        status,
        createdByRoomote: false,
      })),
    );
    await openTaskResolutionOnCloseout(task.id);
    return { task, repository };
  }

  it('resolves two concurrently closed pull requests from their final aggregate', async () => {
    const { task, repository } = await createTaskWithPullRequests([
      'open',
      'open',
    ]);

    await Promise.all([
      updateTaskPrStatus('github', repository, 1, 'closed'),
      updateTaskPrStatus('github', repository, 2, 'closed'),
    ]);

    const [resolved] = await db
      .select({ resolutionStatus: tasks.resolutionStatus })
      .from(tasks)
      .where(eq(tasks.id, task.id));
    expect(resolved?.resolutionStatus).toBe('needs_follow_up');
  });

  it.each(['open', 'closed', 'draft'] as const)(
    'does not downgrade a merged pull request after a later %s event',
    async (staleStatus) => {
      const { task, repository } = await createTaskWithPullRequests(['open']);

      await updateTaskPrStatus('github', repository, 1, 'merged');
      await updateTaskPrStatus('github', repository, 1, staleStatus);

      const [pullRequest] = await db
        .select({ status: taskPullRequests.status })
        .from(taskPullRequests)
        .where(eq(taskPullRequests.taskId, task.id));
      const [resolved] = await db
        .select({ resolutionStatus: tasks.resolutionStatus })
        .from(tasks)
        .where(eq(tasks.id, task.id));
      expect(pullRequest?.status).toBe('merged');
      expect(resolved?.resolutionStatus).toBe('acknowledged');
    },
  );
});
