import {
  findActiveSlackJob,
  findCompletedSlackJobWithSnapshot,
  type SlackNotifier,
} from '@roomote/slack';

type ActiveSlackThreadJob = NonNullable<
  Awaited<ReturnType<typeof findActiveSlackJob>>
>;
type CompletedSlackThreadJob = NonNullable<
  Awaited<ReturnType<typeof findCompletedSlackJobWithSnapshot>>
>;

type SlackThreadFollowUpRoute =
  | { kind: 'active'; activeJob: ActiveSlackThreadJob }
  | { kind: 'resume'; completedJob: CompletedSlackThreadJob }
  | { kind: 'fresh' };

type SlackThreadFollowUpResumeHandlerResult<T> =
  | { handled: true; value: T }
  | { handled: false };

export async function resolveSlackThreadFollowUpRoute(params: {
  threadId: string;
  prefetchedActiveJob?: ActiveSlackThreadJob | null;
  allowCompletedResume?: boolean;
}): Promise<SlackThreadFollowUpRoute> {
  const { threadId, prefetchedActiveJob, allowCompletedResume = true } = params;
  const activeJob =
    prefetchedActiveJob === undefined
      ? await findActiveSlackJob(threadId)
      : prefetchedActiveJob;

  if (activeJob) {
    return { kind: 'active', activeJob };
  }

  if (!allowCompletedResume) {
    return { kind: 'fresh' };
  }

  const completedJob = await findCompletedSlackJobWithSnapshot(threadId);

  if (completedJob?.snapshotId) {
    return { kind: 'resume', completedJob };
  }

  return { kind: 'fresh' };
}

export async function dispatchSlackThreadFollowUp<T>(params: {
  route: SlackThreadFollowUpRoute;
  slack: SlackNotifier;
  channel: string;
  threadId: string;
  onActive?: (activeJob: ActiveSlackThreadJob) => Promise<T>;
  onResume?: (
    completedJob: CompletedSlackThreadJob,
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
      value: await onActive(route.activeJob),
    };
  }

  if (route.kind === 'resume') {
    if (!onResume) {
      return { kind: 'resume' };
    }

    const resumeResult = await onResume(route.completedJob);

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
