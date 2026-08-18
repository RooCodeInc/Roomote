import {
  findActiveSlackTaskRun,
  findCompletedSlackTaskRunWithSnapshot,
  type SlackNotifier,
} from '@roomote/slack';

type ActiveSlackThreadTaskRun = NonNullable<
  Awaited<ReturnType<typeof findActiveSlackTaskRun>>
>;
type CompletedSlackThreadTaskRun = NonNullable<
  Awaited<ReturnType<typeof findCompletedSlackTaskRunWithSnapshot>>
>;

type SlackThreadFollowUpRoute =
  | { kind: 'active'; activeRun: ActiveSlackThreadTaskRun }
  | { kind: 'resume'; completedRun: CompletedSlackThreadTaskRun }
  | { kind: 'fresh' };

type SlackThreadFollowUpResumeHandlerResult<T> =
  | { handled: true; value: T }
  | { handled: false };

export async function resolveSlackThreadFollowUpRoute(params: {
  threadId: string;
  channelId: string;
  slackTeamId: string;
  taskId?: string;
  prefetchedActiveRun?: ActiveSlackThreadTaskRun | null;
  allowCompletedResume?: boolean;
}): Promise<SlackThreadFollowUpRoute> {
  const {
    threadId,
    slackTeamId,
    prefetchedActiveRun,
    allowCompletedResume = true,
  } = params;
  const lookupScope = params.taskId
    ? {
        taskId: params.taskId,
        trackedAlias: {
          slackTeamId,
          channelId: params.channelId,
          threadTs: threadId,
        },
      }
    : { slackTeamId };
  const activeRun =
    prefetchedActiveRun === undefined
      ? await findActiveSlackTaskRun(threadId, lookupScope)
      : prefetchedActiveRun;

  if (activeRun) {
    return { kind: 'active', activeRun };
  }

  if (!allowCompletedResume) {
    return { kind: 'fresh' };
  }

  const completedRun = await findCompletedSlackTaskRunWithSnapshot(
    threadId,
    lookupScope,
  );

  if (completedRun?.snapshotId) {
    return { kind: 'resume', completedRun };
  }

  return { kind: 'fresh' };
}

export async function dispatchSlackThreadFollowUp<T>(params: {
  route: SlackThreadFollowUpRoute;
  slack: SlackNotifier;
  channel: string;
  threadId: string;
  onActive?: (activeRun: ActiveSlackThreadTaskRun) => Promise<T>;
  onResume?: (
    completedRun: CompletedSlackThreadTaskRun,
  ) => Promise<SlackThreadFollowUpResumeHandlerResult<T>>;
  onFresh?: () => Promise<T>;
}): Promise<
  | { kind: 'active'; value?: T }
  | { kind: 'resume'; value?: T }
  | { kind: 'fresh'; value?: T }
> {
  const { route, onActive, onResume, onFresh } = params;

  if (route.kind === 'active') {
    if (!onActive) {
      return { kind: 'active' };
    }

    return {
      kind: 'active',
      value: await onActive(route.activeRun),
    };
  }

  if (route.kind === 'resume') {
    if (!onResume) {
      return { kind: 'resume' };
    }

    const resumeResult = await onResume(route.completedRun);

    if (resumeResult.handled) {
      return {
        kind: 'resume',
        value: resumeResult.value,
      };
    }

    if (!onFresh) {
      return { kind: 'fresh' };
    }

    return {
      kind: 'fresh',
      value: await onFresh(),
    };
  }

  if (!onFresh) {
    return { kind: 'fresh' };
  }

  return {
    kind: 'fresh',
    value: await onFresh(),
  };
}
