import { type CloudJob, cloudJobs, db, eq } from '@roomote/db/server';
import {
  getSlackChannelFromTaskPayload,
  getSlackThreadTsFromTaskPayload,
} from '@roomote/types';

type SlackJobRoutingRecord = Pick<
  CloudJob,
  'id' | 'payload' | 'slackThreadTs' | 'sourceCloudJobId'
>;

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

export async function resolveSlackJobRouting(
  job: SlackJobRoutingRecord,
): Promise<{
  channel: string | null;
  threadTs: string | null;
  route: SlackJobRoute;
}> {
  let channel = getSlackChannelFromTaskPayload(job.payload);
  let threadTs =
    getSlackThreadTsFromTaskPayload(job.payload) ?? job.slackThreadTs ?? null;
  let webPath = getSlackWebPathFromPayload(job.payload);

  const visitedJobIds = new Set<number>([job.id]);
  let sourceCloudJobId = job.sourceCloudJobId;

  while (sourceCloudJobId && (!channel || !threadTs || !webPath)) {
    if (visitedJobIds.has(sourceCloudJobId)) {
      break;
    }

    visitedJobIds.add(sourceCloudJobId);

    const sourceJob = await db.query.cloudJobs.findFirst({
      columns: {
        id: true,
        payload: true,
        slackThreadTs: true,
        sourceCloudJobId: true,
      },
      where: eq(cloudJobs.id, sourceCloudJobId),
    });

    if (!sourceJob) {
      break;
    }

    channel ||= getSlackChannelFromTaskPayload(sourceJob.payload);
    threadTs ||=
      getSlackThreadTsFromTaskPayload(sourceJob.payload) ??
      sourceJob.slackThreadTs ??
      null;
    webPath ||= getSlackWebPathFromPayload(sourceJob.payload);
    sourceCloudJobId = sourceJob.sourceCloudJobId;
  }

  return { channel, threadTs, route: classifySlackJobRoute(webPath) };
}
