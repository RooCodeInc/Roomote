import {
  type TaskRun,
  db,
  desc,
  eq,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import {
  getSlackChannelFromTaskPayload,
  getSlackTeamIdFromTaskPayload,
  getSlackThreadTsFromTaskPayload,
} from '@roomote/types';

type SlackTaskRunRoutingRecord = Pick<TaskRun, 'id' | 'taskId' | 'payload'>;

type SlackTaskRunRoute =
  | {
      kind: 'setup-onboarding';
      webPath: '/setup';
    }
  | {
      kind: 'task';
      webPath: string | null;
    };

function getSlackWebPathFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const webPath = (payload as { webPath?: unknown }).webPath;

  if (typeof webPath !== 'string' || !webPath.startsWith('/')) {
    return null;
  }

  return webPath;
}

function classifySlackTaskRunRoute(webPath: string | null): SlackTaskRunRoute {
  if (webPath === '/setup') {
    return {
      kind: 'setup-onboarding',
      webPath,
    };
  }

  return {
    kind: 'task',
    webPath,
  };
}

/**
 * Resolve Slack routing for a run. Channel bindings are canonical on the
 * tasks row (slackChannelId/slackThreadTs); payloads are only a fallback for
 * the setup webPath and legacy payload-only routing. Instead of walking a
 * sourceRunId chain, this scans the sibling runs of the same task.
 */
export async function resolveSlackTaskRunRouting(
  run: SlackTaskRunRoutingRecord,
): Promise<{
  channel: string | null;
  teamId: string | null;
  threadTs: string | null;
  route: SlackTaskRunRoute;
}> {
  const task = await db.query.tasks.findFirst({
    columns: {
      slackChannelId: true,
      slackThreadTs: true,
    },
    where: eq(tasks.id, run.taskId),
  });

  let channel: string | null =
    task?.slackChannelId ?? getSlackChannelFromTaskPayload(run.payload);
  let teamId = getSlackTeamIdFromTaskPayload(run.payload);
  let threadTs: string | null =
    task?.slackThreadTs ?? getSlackThreadTsFromTaskPayload(run.payload);
  let webPath = getSlackWebPathFromPayload(run.payload);

  if (!channel || !teamId || !threadTs || !webPath) {
    const siblingRuns = await db.query.taskRuns.findMany({
      columns: {
        id: true,
        payload: true,
      },
      where: eq(taskRuns.taskId, run.taskId),
      orderBy: [desc(taskRuns.id)],
    });

    for (const siblingRun of siblingRuns) {
      if (siblingRun.id === run.id) {
        continue;
      }

      channel ||= getSlackChannelFromTaskPayload(siblingRun.payload);
      teamId ||= getSlackTeamIdFromTaskPayload(siblingRun.payload);
      threadTs ||= getSlackThreadTsFromTaskPayload(siblingRun.payload);
      webPath ||= getSlackWebPathFromPayload(siblingRun.payload);

      if (channel && teamId && threadTs && webPath) {
        break;
      }
    }
  }

  return {
    channel,
    teamId,
    threadTs,
    route: classifySlackTaskRunRoute(webPath),
  };
}
