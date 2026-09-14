import {
  automationResults,
  db,
  eq,
  taskFactory,
  tasks,
  userFactory,
  users,
  workItems,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import { actOnResultCommand, listResultsCommand } from './results';

describe('Results commands', () => {
  it('sorts unread items by priority then recency and removes acted-on items', async () => {
    const user = await userFactory.create({
      metadata: { results_page_enabled: true },
    });
    const auth = { userId: user.id } as UserAuthSuccess;
    const sourceTask = await taskFactory.create({
      repositoryName: 'RooCodeInc/Roomote',
      repositoryUrl: 'https://github.com/RooCodeInc/Roomote',
    });
    const [report] = await db
      .insert(automationResults)
      .values({
        userId: user.id,
        automationName: 'Daily report',
        content: 'Report body',
        priority: 'normal',
        dedupeKey: `test:${user.id}:report`,
        sourceTaskId: sourceTask.id,
      })
      .returning({ id: automationResults.id });
    const [suggestion] = await db
      .insert(workItems)
      .values({
        kind: 'suggestion',
        title: 'Patch the alert',
        brief: 'Suggestion body',
        status: 'open',
        sortOrder: 0,
        resultAutomationName: 'Security Auditor',
        resultPriority: 'critical',
        resultUserId: user.id,
        sourceTaskId: sourceTask.id,
        targetRepositoryFullName: 'RooCodeInc/Roomote',
      })
      .returning({ id: workItems.id });

    try {
      const results = await listResultsCommand(auth);
      expect(results.map((result) => result.id)).toEqual([
        suggestion!.id,
        report!.id,
      ]);
      expect(results).toEqual([
        expect.objectContaining({
          id: suggestion!.id,
          repositoryUrl: 'https://github.com/RooCodeInc/Roomote',
        }),
        expect.objectContaining({
          id: report!.id,
          repositoryUrl: 'https://github.com/RooCodeInc/Roomote',
        }),
      ]);

      await db
        .update(tasks)
        .set({ deletedAt: new Date() })
        .where(eq(tasks.id, sourceTask.id));
      await expect(listResultsCommand(auth)).resolves.toEqual([
        expect.objectContaining({ id: suggestion!.id, repositoryUrl: null }),
        expect.objectContaining({ id: report!.id, repositoryUrl: null }),
      ]);

      await actOnResultCommand(auth, {
        id: suggestion!.id,
        kind: 'suggestion',
        action: 'accept',
      });
      await expect(listResultsCommand(auth)).resolves.toEqual([
        expect.objectContaining({ id: report!.id }),
      ]);
    } finally {
      await db.delete(workItems).where(eq(workItems.id, suggestion!.id));
      await db
        .delete(automationResults)
        .where(eq(automationResults.id, report!.id));
      await db.delete(tasks).where(eq(tasks.id, sourceTask.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  });
});
