import {
  and,
  automationResults,
  count,
  db,
  desc,
  eq,
  isNotNull,
  isNull,
  or,
  sql,
  tasks,
  workItems,
} from '@roomote/db/server';
import {
  AUTOMATION_RESULT_PRIORITY_RANK,
  type BackgroundAutomationKey,
  type AutomationResultPriority,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';
import { getPersonalPreferencesCommand } from './preferences';

export type ResultInboxItem = {
  id: string;
  kind: 'report' | 'suggestion';
  automationName: string;
  title: string | null;
  content: string;
  priority: AutomationResultPriority;
  createdAt: Date;
  automationKey: BackgroundAutomationKey | null;
  repositoryUrl: string | null;
};

function githubRepositoryUrl(
  repositoryName: string | null,
  repositoryUrl: string | null,
) {
  if (!repositoryName || !repositoryUrl) return null;

  try {
    const url = new URL(repositoryUrl);
    const path = url.pathname.replace(/^\//u, '').replace(/\/$/u, '');
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      path.toLowerCase() !== repositoryName.toLowerCase()
    ) {
      return null;
    }

    return `https://github.com/${path}`;
  } catch {
    return null;
  }
}

async function assertResultsEnabled(auth: UserAuthSuccess) {
  if (!(await getPersonalPreferencesCommand(auth)).resultsPageEnabled) {
    throw new Error('Results is not enabled.');
  }
}

const visibleReport = (userId: string) =>
  or(isNull(automationResults.userId), eq(automationResults.userId, userId))!;
const visibleSuggestion = (userId: string) =>
  and(
    isNotNull(workItems.resultAutomationName),
    or(isNull(workItems.resultUserId), eq(workItems.resultUserId, userId))!,
  )!;

export async function listResultsCommand(
  auth: UserAuthSuccess,
): Promise<ResultInboxItem[]> {
  await assertResultsEnabled(auth);
  const [reports, suggestions] = await Promise.all([
    db
      .select({
        id: automationResults.id,
        automationKey: automationResults.automationKey,
        automationName: automationResults.automationName,
        content: automationResults.content,
        priority: automationResults.priority,
        createdAt: automationResults.createdAt,
        sourceRepositoryName: tasks.repositoryName,
        sourceRepositoryUrl: tasks.repositoryUrl,
      })
      .from(automationResults)
      .leftJoin(
        tasks,
        and(
          eq(tasks.id, automationResults.sourceTaskId),
          isNull(tasks.deletedAt),
        ),
      )
      .where(
        and(
          visibleReport(auth.userId),
          isNull(automationResults.acceptedAt),
          isNull(automationResults.ignoredAt),
        ),
      )
      .orderBy(
        sql`case ${automationResults.priority} when 'critical' then 2 when 'high' then 1 else 0 end desc`,
        desc(automationResults.createdAt),
      )
      .limit(100),
    db
      .select({
        id: workItems.id,
        automationKey: workItems.automationKey,
        automationName: workItems.resultAutomationName,
        title: workItems.title,
        content: workItems.brief,
        priority: workItems.resultPriority,
        createdAt: workItems.createdAt,
        targetRepositoryFullName: workItems.targetRepositoryFullName,
        sourceRepositoryName: tasks.repositoryName,
        sourceRepositoryUrl: tasks.repositoryUrl,
      })
      .from(workItems)
      .leftJoin(
        tasks,
        and(eq(tasks.id, workItems.sourceTaskId), isNull(tasks.deletedAt)),
      )
      .where(
        and(
          visibleSuggestion(auth.userId),
          isNull(workItems.resultAcceptedAt),
          isNull(workItems.resultIgnoredAt),
        ),
      )
      .orderBy(
        sql`case ${workItems.resultPriority} when 'critical' then 2 when 'high' then 1 else 0 end desc`,
        desc(workItems.createdAt),
      )
      .limit(100),
  ]);

  return [
    ...reports.map(
      ({ sourceRepositoryName, sourceRepositoryUrl, ...result }) => ({
        ...result,
        kind: 'report' as const,
        title: null,
        repositoryUrl: githubRepositoryUrl(
          sourceRepositoryName,
          sourceRepositoryUrl,
        ),
      }),
    ),
    ...suggestions.map(
      ({
        sourceRepositoryName,
        sourceRepositoryUrl,
        targetRepositoryFullName,
        ...result
      }) => ({
        ...result,
        kind: 'suggestion' as const,
        automationName: result.automationName ?? 'Automation',
        content: result.content ?? '',
        priority: result.priority ?? 'normal',
        repositoryUrl:
          !targetRepositoryFullName ||
          targetRepositoryFullName.toLowerCase() ===
            sourceRepositoryName?.toLowerCase()
            ? githubRepositoryUrl(sourceRepositoryName, sourceRepositoryUrl)
            : null,
      }),
    ),
  ]
    .toSorted(
      (left, right) =>
        AUTOMATION_RESULT_PRIORITY_RANK[right.priority] -
          AUTOMATION_RESULT_PRIORITY_RANK[left.priority] ||
        right.createdAt.getTime() - left.createdAt.getTime(),
    )
    .slice(0, 100);
}

export async function getUnreadResultCountCommand(auth: UserAuthSuccess) {
  if (!(await getPersonalPreferencesCommand(auth)).resultsPageEnabled) return 0;
  const [reportRows, suggestionRows] = await Promise.all([
    db
      .select({ count: count() })
      .from(automationResults)
      .where(
        and(
          visibleReport(auth.userId),
          isNull(automationResults.acceptedAt),
          isNull(automationResults.ignoredAt),
        ),
      ),
    db
      .select({ count: count() })
      .from(workItems)
      .where(
        and(
          visibleSuggestion(auth.userId),
          isNull(workItems.resultAcceptedAt),
          isNull(workItems.resultIgnoredAt),
        ),
      ),
  ]);
  return (
    Number(reportRows[0]?.count ?? 0) + Number(suggestionRows[0]?.count ?? 0)
  );
}

export async function actOnResultCommand(
  auth: UserAuthSuccess,
  input: {
    id: string;
    kind: 'report' | 'suggestion';
    action: 'accept' | 'ignore';
  },
) {
  await assertResultsEnabled(auth);
  const now = new Date();
  const values =
    input.action === 'accept'
      ? { acceptedAt: now, ignoredAt: null, updatedAt: now }
      : { acceptedAt: null, ignoredAt: now, updatedAt: now };

  if (input.kind === 'report') {
    await db
      .update(automationResults)
      .set(values)
      .where(
        and(eq(automationResults.id, input.id), visibleReport(auth.userId)),
      );
  } else {
    await db
      .update(workItems)
      .set({
        resultAcceptedAt: values.acceptedAt,
        resultIgnoredAt: values.ignoredAt,
        updatedAt: now,
      })
      .where(and(eq(workItems.id, input.id), visibleSuggestion(auth.userId)));
  }

  return { success: true as const };
}

export async function clearResultsCommand(auth: UserAuthSuccess) {
  await assertResultsEnabled(auth);
  const now = new Date();
  await Promise.all([
    db
      .update(automationResults)
      .set({ ignoredAt: now, updatedAt: now })
      .where(
        and(
          visibleReport(auth.userId),
          isNull(automationResults.acceptedAt),
          isNull(automationResults.ignoredAt),
        ),
      ),
    db
      .update(workItems)
      .set({ resultIgnoredAt: now, updatedAt: now })
      .where(
        and(
          visibleSuggestion(auth.userId),
          isNull(workItems.resultAcceptedAt),
          isNull(workItems.resultIgnoredAt),
        ),
      ),
  ]);
  return { success: true as const };
}
