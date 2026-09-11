import {
  automationResults,
  db,
  eq,
  inArray,
  recordSuggestionResults,
  userFactory,
  users,
  workItems,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import {
  actOnResultCommand,
  clearResultsCommand,
  getUnreadResultCountCommand,
  listResultsCommand,
} from './results';

describe('Results commands', () => {
  it('sorts unread items by priority then recency and removes acted-on items', async () => {
    const user = await userFactory.create({
      metadata: { results_page_enabled: true },
    });
    const auth = { userId: user.id } as UserAuthSuccess;
    const [report] = await db
      .insert(automationResults)
      .values({
        userId: user.id,
        automationName: 'Daily report',
        content: 'Report body',
        priority: 'normal',
        dedupeKey: `test:${user.id}:report`,
      })
      .returning({ id: automationResults.id });
    const [suggestionWorkItem] = await db
      .insert(workItems)
      .values({
        kind: 'suggestion',
        title: 'Patch the alert',
        brief: 'Suggestion body',
        status: 'open',
        sortOrder: 0,
      })
      .returning({ id: workItems.id, createdAt: workItems.createdAt });
    const [suggestion] = await recordSuggestionResults([
      {
        workItemId: suggestionWorkItem!.id,
        automationKey: null,
        userId: user.id,
        automationName: 'Security Auditor',
        title: 'Patch the alert',
        content: 'Suggestion body',
        priority: 'critical',
        createdAt: suggestionWorkItem!.createdAt,
      },
    ]);

    try {
      const results = await listResultsCommand(auth);
      expect(results.map((result) => result.id)).toEqual([
        suggestion!.id,
        report!.id,
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
      await db
        .delete(automationResults)
        .where(inArray(automationResults.id, [report!.id, suggestion!.id]));
      await db
        .delete(workItems)
        .where(eq(workItems.id, suggestionWorkItem!.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  });

  it('counts and clears only visible canonical results', async () => {
    const [user, otherUser] = await Promise.all([
      userFactory.create({ metadata: { results_page_enabled: true } }),
      userFactory.create({ metadata: { results_page_enabled: true } }),
    ]);
    const auth = { userId: user.id } as UserAuthSuccess;
    const before = await getUnreadResultCountCommand(auth);
    const inserted = await db
      .insert(automationResults)
      .values([
        {
          userId: user.id,
          automationName: 'Visible report',
          content: 'Visible',
          dedupeKey: `test:${user.id}:visible`,
        },
        {
          userId: otherUser.id,
          automationName: 'Private report',
          content: 'Hidden',
          dedupeKey: `test:${user.id}:hidden`,
        },
      ])
      .returning({ id: automationResults.id });

    try {
      await expect(getUnreadResultCountCommand(auth)).resolves.toBe(before + 1);
      await clearResultsCommand(auth);
      await expect(getUnreadResultCountCommand(auth)).resolves.toBe(0);

      const hidden = await db.query.automationResults.findFirst({
        where: eq(automationResults.id, inserted[1]!.id),
        columns: { ignoredAt: true },
      });
      expect(hidden?.ignoredAt).toBeNull();
    } finally {
      await db.delete(automationResults).where(
        inArray(
          automationResults.id,
          inserted.map((row) => row.id),
        ),
      );
      await db.delete(users).where(inArray(users.id, [user.id, otherUser.id]));
    }
  });
});
