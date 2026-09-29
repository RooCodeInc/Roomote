import {
  and,
  automationResults,
  count,
  db,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  privateSessionAccess,
  privateTaskAccess,
  sessionTasks,
  sessions,
  sql,
  taskArtifacts,
  taskPullRequests,
  tasks,
  workItems,
} from '@roomote/db/server';
import {
  AUTOMATION_RESULT_PRIORITY_RANK,
  type AutomationResultPreparationStatus,
  type BackgroundAutomationKey,
  type AutomationResultPriority,
} from '@roomote/types';

import type { UserAuthSuccess } from '@/types';

export type ResultAction =
  | {
      kind: 'navigate';
      action:
        | 'open_task'
        | 'respond_in_task'
        | 'open_session'
        | 'open_pr'
        | 'open_artifact';
      label: string;
      href: string;
      external: boolean;
    }
  | {
      kind: 'start_suggestion';
      action: 'start_investigation';
      label: string;
      initialPrompt: string;
    };

export type ResultPullRequest = {
  url: string;
  title: string | null;
  repository: string | null;
  number: number | null;
};

export type ResultInboxItem = {
  id: string;
  kind: 'report' | 'suggestion';
  automationName: string;
  headline: string;
  decisionContext: string;
  content: string;
  priority: AutomationResultPriority;
  createdAt: Date;
  automationKey: BackgroundAutomationKey | null;
  preparationStatus: AutomationResultPreparationStatus | 'not_required';
  actions: ResultAction[];
  pullRequests: ResultPullRequest[];
};

const visibleReport = () =>
  and(
    eq(automationResults.resultVisibility, 'shared'),
    isNull(automationResults.supersededAt),
    sql`coalesce(${automationResults.launchCriteriaOutcome}->>'launchCriteria', '') <> 'skipped'`,
    sql`coalesce(${automationResults.launchCriteriaOutcome}->>'runWhen', '') <> 'skipped'`,
  )!;
const visibleSuggestion = () =>
  and(
    isNotNull(workItems.resultAutomationName),
    eq(workItems.resultVisibility, 'shared'),
    eq(workItems.status, 'open'),
  )!;

function safeExternalUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function listResultsCommand(
  auth: UserAuthSuccess,
): Promise<ResultInboxItem[]> {
  const linkedSessionId = sql<
    string | null
  >`coalesce(${automationResults.sourceSessionId}, ${sessionTasks.sessionId})`;
  const [reports, suggestions] = await Promise.all([
    db
      .select({
        id: automationResults.id,
        automationKey: automationResults.automationKey,
        automationName: automationResults.automationName,
        headline: automationResults.headline,
        decisionContext: automationResults.decisionContext,
        content: automationResults.content,
        priority: automationResults.priority,
        preparationStatus: automationResults.preparationStatus,
        createdAt: automationResults.createdAt,
        sourceTaskId: tasks.id,
        sourceTaskState: tasks.state,
        sourceSessionId: sessions.id,
      })
      .from(automationResults)
      .leftJoin(
        tasks,
        and(
          eq(tasks.id, automationResults.sourceTaskId),
          isNull(tasks.deletedAt),
          privateTaskAccess(auth),
        ),
      )
      .leftJoin(sessionTasks, eq(sessionTasks.taskId, tasks.id))
      .leftJoin(
        sessions,
        and(eq(sessions.id, linkedSessionId), privateSessionAccess(auth)),
      )
      .where(
        and(
          visibleReport(),
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
        sourceTaskId: tasks.id,
        automationKey: workItems.automationKey,
        automationName: workItems.resultAutomationName,
        headline: workItems.title,
        decisionContext: workItems.brief,
        priority: workItems.resultPriority,
        createdAt: workItems.createdAt,
        status: workItems.status,
      })
      .from(workItems)
      .leftJoin(
        tasks,
        and(
          eq(tasks.id, workItems.sourceTaskId),
          isNull(tasks.deletedAt),
          privateTaskAccess(auth),
        ),
      )
      .where(
        and(
          visibleSuggestion(),
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

  const reportTaskIds = reports
    .map((report) => report.sourceTaskId)
    .filter((taskId): taskId is string => Boolean(taskId));
  const taskIds = [
    ...new Set(
      [
        ...reportTaskIds,
        ...suggestions.map((suggestion) => suggestion.sourceTaskId),
      ].filter((taskId): taskId is string => Boolean(taskId)),
    ),
  ];
  const pullRequests =
    taskIds.length === 0
      ? []
      : await db
          .select({
            taskId: taskPullRequests.taskId,
            url: taskPullRequests.prUrl,
            title: taskPullRequests.prTitle,
            repository: taskPullRequests.repository,
            number: taskPullRequests.prNumber,
            createdByRoomote: taskPullRequests.createdByRoomote,
          })
          .from(taskPullRequests)
          .where(inArray(taskPullRequests.taskId, taskIds))
          .orderBy(
            desc(taskPullRequests.createdByRoomote),
            desc(taskPullRequests.detectedAt),
          );
  const artifacts =
    reportTaskIds.length === 0
      ? []
      : await db
          .select({
            taskId: taskArtifacts.taskId,
            path: taskArtifacts.path,
            artifactType: taskArtifacts.artifactType,
          })
          .from(taskArtifacts)
          .where(
            and(
              inArray(taskArtifacts.taskId, reportTaskIds),
              eq(taskArtifacts.uploaded, true),
            ),
          )
          .orderBy(desc(taskArtifacts.createdAt));
  const pullRequestsByTaskId = new Map<string, ResultPullRequest[]>();
  for (const pullRequest of pullRequests) {
    const url = safeExternalUrl(pullRequest.url);
    if (!url) continue;
    const associated = pullRequestsByTaskId.get(pullRequest.taskId) ?? [];
    associated.push({
      url,
      title: pullRequest.title,
      repository: pullRequest.repository,
      number: pullRequest.number,
    });
    pullRequestsByTaskId.set(pullRequest.taskId, associated);
  }
  const artifactByTaskId = new Map<string, (typeof artifacts)[number]>();
  for (const artifact of artifacts) {
    if (artifact.taskId && !artifactByTaskId.has(artifact.taskId)) {
      artifactByTaskId.set(artifact.taskId, artifact);
    }
  }

  return [
    ...reports.map((report): ResultInboxItem => {
      const actions: ResultAction[] = [];
      if (report.sourceTaskId) {
        actions.push({
          kind: 'navigate',
          action:
            report.sourceTaskState === 'active'
              ? 'respond_in_task'
              : 'open_task',
          label:
            report.sourceTaskState === 'active'
              ? 'Respond in task'
              : 'Open task',
          href: `/task/${report.sourceTaskId}`,
          external: false,
        });
      } else if (report.sourceSessionId) {
        actions.push({
          kind: 'navigate',
          action: 'open_session',
          label: 'Open session',
          href: `/sessions/${report.sourceSessionId}`,
          external: false,
        });
      }
      const resultPullRequests = report.sourceTaskId
        ? (pullRequestsByTaskId.get(report.sourceTaskId) ?? [])
        : [];
      const pullRequest = resultPullRequests[0];
      if (pullRequest) {
        actions.push({
          kind: 'navigate',
          action: 'open_pr',
          label: pullRequest?.title ? 'Open pull request' : 'Open PR',
          href: pullRequest.url,
          external: true,
        });
      }
      const artifact = report.sourceTaskId
        ? artifactByTaskId.get(report.sourceTaskId)
        : null;
      if (artifact && report.sourceTaskId) {
        const query = new URLSearchParams({ path: artifact.path });
        actions.push({
          kind: 'navigate',
          action: 'open_artifact',
          label:
            artifact.artifactType === 'plan' ? 'Open plan' : 'Open artifact',
          href: `/task/${report.sourceTaskId}/artifacts?${query.toString()}`,
          external: false,
        });
      }
      return {
        id: report.id,
        kind: 'report',
        automationKey: report.automationKey,
        automationName: report.automationName,
        headline: report.headline ?? `${report.automationName} result`,
        decisionContext:
          report.decisionContext ?? 'Open the result for the full outcome.',
        content: report.content,
        priority: report.priority,
        preparationStatus: report.preparationStatus,
        createdAt: report.createdAt,
        actions,
        pullRequests: resultPullRequests,
      };
    }),
    ...suggestions.map(
      (suggestion): ResultInboxItem => ({
        id: suggestion.id,
        kind: 'suggestion',
        automationKey: suggestion.automationKey,
        automationName: suggestion.automationName ?? 'Automation',
        headline: suggestion.headline,
        decisionContext: suggestion.decisionContext ?? '',
        content: '',
        priority: suggestion.priority ?? 'normal',
        preparationStatus: 'not_required',
        createdAt: suggestion.createdAt,
        pullRequests: suggestion.sourceTaskId
          ? (pullRequestsByTaskId.get(suggestion.sourceTaskId) ?? [])
          : [],
        actions:
          suggestion.status === 'open'
            ? [
                {
                  kind: 'start_suggestion',
                  action: 'start_investigation',
                  label: 'Start investigation',
                  initialPrompt: [
                    suggestion.headline,
                    suggestion.decisionContext,
                  ]
                    .filter(Boolean)
                    .join('\n\n'),
                },
              ]
            : [],
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

export async function getResultCommand(
  auth: UserAuthSuccess,
  input: { id: string; kind: 'report' | 'suggestion' },
) {
  const results = await listResultsCommand(auth);
  return (
    results.find(
      (result) => result.id === input.id && result.kind === input.kind,
    ) ?? null
  );
}

export async function getPendingResultCountCommand(_auth: UserAuthSuccess) {
  const [reportRows, suggestionRows] = await Promise.all([
    db
      .select({ count: count() })
      .from(automationResults)
      .where(
        and(
          visibleReport(),
          isNull(automationResults.acceptedAt),
          isNull(automationResults.ignoredAt),
        ),
      ),
    db
      .select({ count: count() })
      .from(workItems)
      .where(
        and(
          visibleSuggestion(),
          isNull(workItems.resultAcceptedAt),
          isNull(workItems.resultIgnoredAt),
        ),
      ),
  ]);
  return (
    Number(reportRows[0]?.count ?? 0) + Number(suggestionRows[0]?.count ?? 0)
  );
}

export async function getUnreadResultCountCommand(auth: UserAuthSuccess) {
  return getPendingResultCountCommand(auth);
}

export async function clearResultCommand(
  _auth: UserAuthSuccess,
  input: { id: string; kind: 'report' | 'suggestion' },
) {
  const now = new Date();
  const changed =
    input.kind === 'report'
      ? await db
          .update(automationResults)
          .set({ ignoredAt: now, updatedAt: now })
          .where(
            and(
              eq(automationResults.id, input.id),
              visibleReport(),
              isNull(automationResults.acceptedAt),
              isNull(automationResults.ignoredAt),
            ),
          )
          .returning({ id: automationResults.id })
      : await db
          .update(workItems)
          .set({ resultIgnoredAt: now, updatedAt: now })
          .where(
            and(
              eq(workItems.id, input.id),
              visibleSuggestion(),
              isNull(workItems.resultAcceptedAt),
              isNull(workItems.resultIgnoredAt),
            ),
          )
          .returning({ id: workItems.id });
  return { success: changed.length > 0 };
}

export async function acceptSuggestionResultCommand(
  _auth: UserAuthSuccess,
  input: { id: string },
) {
  const now = new Date();
  const changed = await db
    .update(workItems)
    .set({ resultAcceptedAt: now, updatedAt: now })
    .where(
      and(
        eq(workItems.id, input.id),
        visibleSuggestion(),
        isNull(workItems.resultAcceptedAt),
        isNull(workItems.resultIgnoredAt),
      ),
    )
    .returning({ id: workItems.id });
  return { success: changed.length > 0 };
}

export async function clearResultsCommand(_auth: UserAuthSuccess) {
  const now = new Date();
  const [reports, suggestions] = await Promise.all([
    db
      .update(automationResults)
      .set({ ignoredAt: now, updatedAt: now })
      .where(
        and(
          visibleReport(),
          isNull(automationResults.acceptedAt),
          isNull(automationResults.ignoredAt),
        ),
      )
      .returning({ id: automationResults.id }),
    db
      .update(workItems)
      .set({ resultIgnoredAt: now, updatedAt: now })
      .where(
        and(
          visibleSuggestion(),
          isNull(workItems.resultAcceptedAt),
          isNull(workItems.resultIgnoredAt),
        ),
      )
      .returning({ id: workItems.id }),
  ]);
  return {
    success: true as const,
    clearedCount: reports.length + suggestions.length,
  };
}

/** Compatibility for clients deployed before the inbox redesign. */
export async function actOnResultCommand(
  auth: UserAuthSuccess,
  input: {
    id: string;
    kind: 'report' | 'suggestion';
    action: 'accept' | 'ignore';
  },
) {
  if (input.action === 'ignore') return clearResultCommand(auth, input);
  if (input.kind === 'suggestion') {
    return acceptSuggestionResultCommand(auth, { id: input.id });
  }
  const now = new Date();
  await db
    .update(automationResults)
    .set({ acceptedAt: now, acceptanceReason: 'manual', updatedAt: now })
    .where(and(eq(automationResults.id, input.id), visibleReport()));
  return { success: true as const };
}
