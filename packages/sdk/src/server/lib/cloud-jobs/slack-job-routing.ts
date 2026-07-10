import { type Run, db, desc, eq, taskRuns, tasks } from '@roomote/db/server';
import {
  getSlackChannelFromTaskPayload,
  getSlackThreadTsFromTaskPayload,
} from '@roomote/types';

type SlackJobRoutingRecord = Pick<Run, 'id' | 'taskId' | 'payload'>;

type SlackJobRoute =
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

function classifySlackJobRoute(webPath: string | null): SlackJobRoute {
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
 * sourceCloudJobId chain, this scans the sibling runs of the same task.
 */
export async function resolveSlackJobRouting(
  job: SlackJobRoutingRecord,
): Promise<{
  channel: string | null;
  threadTs: string | null;
  route: SlackJobRoute;
}> {
  const task = await db.query.tasks.findFirst({
    columns: {
      slackChannelId: true,
      slackThreadTs: true,
    },
    where: eq(tasks.id, job.taskId),
  });

  let channel: string | null =
    task?.slackChannelId ?? getSlackChannelFromTaskPayload(job.payload);
  let threadTs: string | null =
    task?.slackThreadTs ?? getSlackThreadTsFromTaskPayload(job.payload);
  let webPath = getSlackWebPathFromPayload(job.payload);

  if (!channel || !threadTs || !webPath) {
    const siblingRuns = await db.query.taskRuns.findMany({
      columns: {
        id: true,
        payload: true,
      },
      where: eq(taskRuns.taskId, job.taskId),
      orderBy: [desc(taskRuns.id)],
    });

    for (const run of siblingRuns) {
      if (run.id === job.id) {
        continue;
      }

      channel ||= getSlackChannelFromTaskPayload(run.payload);
      threadTs ||= getSlackThreadTsFromTaskPayload(run.payload);
      webPath ||= getSlackWebPathFromPayload(run.payload);

      if (channel && threadTs && webPath) {
        break;
      }
    }
  }

  return { channel, threadTs, route: classifySlackJobRoute(webPath) };
}
