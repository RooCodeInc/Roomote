import {
  automationResults,
  db,
  eq,
  inArray,
  taskFactory,
  tasks,
  userFactory,
  users,
  workItems,
} from '@roomote/db/server';

const experimentEnabled = vi.hoisted(() => ({ value: false }));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  isDeploymentExperimentEnabled: () => experimentEnabled.value,
}));

import type { UserAuthSuccess } from '@/types';
import {
  actOnResultCommand,
  clearResultsCommand,
  getUnreadResultCountCommand,
  listResultsCommand,
} from './results';

describe('Results commands', () => {
  beforeEach(() => {
    experimentEnabled.value = false;
  });

  it('ignores a legacy per-user opt-in when the deployment experiment is off', async () => {
    const user = await userFactory.create({
      metadata: { results_page_enabled: true },
    });

    await expect(
      listResultsCommand({ userId: user.id } as UserAuthSuccess),
    ).rejects.toThrow('Results is not enabled.');
  });

  it('sorts unread items by priority then recency and removes acted-on items', async () => {
    const user = await userFactory.create();
    experimentEnabled.value = true;
    const auth = { userId: user.id } as UserAuthSuccess;
    const sourceTask = await taskFactory.create({
      title: 'Readable source task',
      repositoryName: 'RooCodeInc/Roomote',
      repositoryUrl: 'https://github.com/RooCodeInc/Roomote',
    });
    const [report] = await db
      .insert(automationResults)
      .values({
        userId: user.id,
        resultVisibility: 'shared',
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
        resultVisibility: 'shared',
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
          sourceTaskId: sourceTask.id,
          sourceTaskTitle: 'Readable source task',
        }),
        expect.objectContaining({
          id: report!.id,
          repositoryUrl: 'https://github.com/RooCodeInc/Roomote',
          sourceTaskId: sourceTask.id,
          sourceTaskTitle: 'Readable source task',
        }),
      ]);

      await db
        .update(tasks)
        .set({ deletedAt: new Date() })
        .where(eq(tasks.id, sourceTask.id));
      await expect(listResultsCommand(auth)).resolves.toEqual([
        expect.objectContaining({
          id: suggestion!.id,
          repositoryUrl: null,
          sourceTaskId: null,
          sourceTaskTitle: null,
        }),
        expect.objectContaining({
          id: report!.id,
          repositoryUrl: null,
          sourceTaskId: null,
          sourceTaskTitle: null,
        }),
      ]);

      await actOnResultCommand(auth, {
        id: suggestion!.id,
        kind: 'suggestion',
        action: 'accept',
      });
      await expect(listResultsCommand(auth)).resolves.toEqual([
        expect.objectContaining({ id: report!.id }),
      ]);

      await actOnResultCommand(auth, {
        id: report!.id,
        kind: 'report',
        action: 'accept',
      });
      const acceptedReport = await db.query.automationResults.findFirst({
        where: eq(automationResults.id, report!.id),
      });
      expect(acceptedReport).toMatchObject({
        acceptanceReason: 'manual',
        ignoredAt: null,
      });
    } finally {
      await db.delete(workItems).where(eq(workItems.id, suggestion!.id));
      await db
        .delete(automationResults)
        .where(eq(automationResults.id, report!.id));
      await db.delete(tasks).where(eq(tasks.id, sourceTask.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  });

  it('exposes source metadata only when the viewer can read the joined task', async () => {
    experimentEnabled.value = true;
    const [owner, viewer] = await Promise.all([
      userFactory.create(),
      userFactory.create(),
    ]);
    const [readableTask, privateTask] = await Promise.all([
      taskFactory.create({ title: 'Readable source' }),
      taskFactory.create({
        title: 'Private source',
        privacy: 'private',
        privateOwnerUserId: owner.id,
      }),
    ]);
    const insertedReports = await db
      .insert(automationResults)
      .values([
        {
          userId: owner.id,
          resultVisibility: 'shared',
          automationName: 'Readable source report',
          content: 'Readable source body',
          dedupeKey: `results-source:${owner.id}:readable`,
          sourceTaskId: readableTask.id,
        },
        {
          userId: owner.id,
          resultVisibility: 'shared',
          automationName: 'Private source report',
          content: 'Private source body',
          dedupeKey: `results-source:${owner.id}:private`,
          sourceTaskId: privateTask.id,
        },
        {
          userId: owner.id,
          resultVisibility: 'shared',
          automationName: 'Missing source report',
          content: 'Missing source body',
          dedupeKey: `results-source:${owner.id}:missing`,
          sourceTaskId: null,
        },
      ])
      .returning({ id: automationResults.id });

    try {
      const results = await listResultsCommand({
        userId: viewer.id,
        isAdmin: false,
      } as UserAuthSuccess);
      const byId = new Map(results.map((result) => [result.id, result]));

      expect(byId.get(insertedReports[0]!.id)).toMatchObject({
        sourceTaskId: readableTask.id,
        sourceTaskTitle: 'Readable source',
      });
      expect(byId.get(insertedReports[1]!.id)).toMatchObject({
        sourceTaskId: null,
        sourceTaskTitle: null,
      });
      expect(byId.get(insertedReports[2]!.id)).toMatchObject({
        sourceTaskId: null,
        sourceTaskTitle: null,
      });
    } finally {
      await db.delete(automationResults).where(
        inArray(
          automationResults.id,
          insertedReports.map(({ id }) => id),
        ),
      );
      await db
        .delete(tasks)
        .where(inArray(tasks.id, [readableTask.id, privateTask.id]));
      await db.delete(users).where(inArray(users.id, [owner.id, viewer.id]));
    }
  });

  it('shares only output snapshotted as shared and applies the same boundary to actions', async () => {
    experimentEnabled.value = true;
    const [creator, member] = await Promise.all([
      userFactory.create({ role: 'admin' }),
      userFactory.create({ role: 'member' }),
    ]);
    const sourceTask = await taskFactory.create();
    const insertedReports = await db
      .insert(automationResults)
      .values([
        {
          userId: creator.id,
          resultVisibility: 'shared',
          automationName: 'Shared report',
          content: 'Visible deployment-wide',
          dedupeKey: `results-visibility:${creator.id}:shared-report`,
          sourceTaskId: sourceTask.id,
        },
        {
          userId: creator.id,
          resultVisibility: 'private',
          automationName: 'Private report',
          content: 'Never visible in Results',
          dedupeKey: `results-visibility:${creator.id}:private-report`,
          sourceTaskId: sourceTask.id,
        },
        {
          userId: creator.id,
          automationName: 'Historical report',
          content: 'Visibility provenance is unknown',
          dedupeKey: `results-visibility:${creator.id}:legacy-report`,
          sourceTaskId: sourceTask.id,
        },
      ])
      .returning({ id: automationResults.id });
    const insertedSuggestions = await db
      .insert(workItems)
      .values(
        (['shared', 'private', null] as const).map((visibility, index) => ({
          kind: 'suggestion' as const,
          title: `${visibility ?? 'historical'} suggestion`,
          brief: 'Suggestion body',
          status: 'open' as const,
          sortOrder: index,
          resultAutomationName: 'Suggestion automation',
          resultPriority: 'normal' as const,
          resultUserId: creator.id,
          resultVisibility: visibility,
          sourceTaskId: sourceTask.id,
        })),
      )
      .returning({ id: workItems.id });
    const [sharedReport, privateReport] = insertedReports;
    const [sharedSuggestion, privateSuggestion] = insertedSuggestions;

    try {
      for (const user of [creator, member]) {
        const auth = {
          userId: user.id,
          isAdmin: user.role === 'admin',
        } as UserAuthSuccess;
        await expect(listResultsCommand(auth)).resolves.toEqual([
          expect.objectContaining({ id: sharedSuggestion!.id }),
          expect.objectContaining({ id: sharedReport!.id }),
        ]);
        await expect(getUnreadResultCountCommand(auth)).resolves.toBe(2);

        await actOnResultCommand(auth, {
          id: privateReport!.id,
          kind: 'report',
          action: 'accept',
        });
        await actOnResultCommand(auth, {
          id: privateSuggestion!.id,
          kind: 'suggestion',
          action: 'ignore',
        });
      }

      expect(
        await db.query.automationResults.findFirst({
          where: eq(automationResults.id, privateReport!.id),
        }),
      ).toMatchObject({ acceptedAt: null, ignoredAt: null });
      expect(
        await db.query.workItems.findFirst({
          where: eq(workItems.id, privateSuggestion!.id),
        }),
      ).toMatchObject({ resultAcceptedAt: null, resultIgnoredAt: null });

      await clearResultsCommand({
        userId: member.id,
        isAdmin: false,
      } as UserAuthSuccess);
      await expect(
        listResultsCommand({ userId: creator.id } as UserAuthSuccess),
      ).resolves.toEqual([]);
      expect(
        await db.query.automationResults.findFirst({
          where: eq(automationResults.id, privateReport!.id),
        }),
      ).toMatchObject({ ignoredAt: null });
    } finally {
      await db.delete(workItems).where(
        inArray(
          workItems.id,
          insertedSuggestions.map(({ id }) => id),
        ),
      );
      await db.delete(automationResults).where(
        inArray(
          automationResults.id,
          insertedReports.map(({ id }) => id),
        ),
      );
      await db.delete(tasks).where(eq(tasks.id, sourceTask.id));
      await db.delete(users).where(inArray(users.id, [creator.id, member.id]));
    }
  });
});
