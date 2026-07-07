import type { RedisLockHandle } from '@roomote/redis';

export type TaskSuggestionReactionLaunchResult =
  | boolean
  | {
      connectAccountFallbackText: string;
    };

export type TaskSuggestionReactionState = {
  taskId: string | null;
  launchClaimedAt: Date | null;
  launchedThreadTs: string | null;
};

export type TaskSuggestionReactionContentionState =
  | 'claimed'
  | 'handled'
  | 'claim-cleared'
  | 'timed-out'
  | 'lock-lost';

type TaskSuggestionReactionContentionTerminalState =
  | 'handled'
  | 'claim-cleared'
  | 'timed-out'
  | 'lock-lost';

function isHandledSuggestionState(
  suggestionState: TaskSuggestionReactionState | null,
): boolean {
  return Boolean(suggestionState?.taskId || suggestionState?.launchedThreadTs);
}

async function emitState(
  onStateTransition:
    | ((state: TaskSuggestionReactionContentionState) => Promise<void> | void)
    | undefined,
  state: TaskSuggestionReactionContentionState,
): Promise<void> {
  await onStateTransition?.(state);
}

async function waitForClaimResolution(params: {
  getState: () => Promise<TaskSuggestionReactionState | null>;
  renewLock: () => Promise<boolean>;
  maxAttempts: number;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  onStateTransition?: (
    state: TaskSuggestionReactionContentionState,
  ) => Promise<void> | void;
}): Promise<'handled' | 'claim-cleared' | 'timed-out' | 'lock-lost'> {
  for (let attempt = 0; attempt <= params.maxAttempts; attempt += 1) {
    const suggestionState = await params.getState();

    if (!suggestionState || !suggestionState.launchClaimedAt) {
      await emitState(params.onStateTransition, 'claim-cleared');
      return 'claim-cleared';
    }

    if (isHandledSuggestionState(suggestionState)) {
      await emitState(params.onStateTransition, 'handled');
      return 'handled';
    }

    if (attempt === params.maxAttempts) {
      break;
    }

    const renewed = await params.renewLock();

    if (!renewed) {
      await emitState(params.onStateTransition, 'lock-lost');
      return 'lock-lost';
    }

    await params.sleep(params.pollIntervalMs);
  }

  await emitState(params.onStateTransition, 'timed-out');
  return 'timed-out';
}

const defaultSleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function runTaskSuggestionReactionContention(params: {
  acquireLock: () => Promise<RedisLockHandle | null>;
  launch: () => Promise<TaskSuggestionReactionLaunchResult>;
  getState: () => Promise<TaskSuggestionReactionState | null>;
  maxAttempts: number;
  pollIntervalMs: number;
  onConnectAccountPrompt?: (fallbackText: string) => Promise<void>;
  onStateTransition?: (
    state: TaskSuggestionReactionContentionState,
  ) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<TaskSuggestionReactionContentionTerminalState> {
  const sleep = params.sleep ?? defaultSleep;

  for (let attempt = 0; attempt <= params.maxAttempts; attempt += 1) {
    const release = await params.acquireLock();

    if (release) {
      try {
        while (true) {
          const launchResult = await params.launch();

          if (typeof launchResult === 'object') {
            await params.onConnectAccountPrompt?.(
              launchResult.connectAccountFallbackText,
            );
            await emitState(params.onStateTransition, 'handled');
            return 'handled';
          }

          if (launchResult) {
            await emitState(params.onStateTransition, 'handled');
            return 'handled';
          }

          const suggestionState = await params.getState();

          if (isHandledSuggestionState(suggestionState)) {
            await emitState(params.onStateTransition, 'handled');
            return 'handled';
          }

          if (!suggestionState?.launchClaimedAt) {
            await emitState(params.onStateTransition, 'claim-cleared');
            return 'claim-cleared';
          }

          await emitState(params.onStateTransition, 'claimed');

          const claimResolution = await waitForClaimResolution({
            getState: params.getState,
            renewLock: () => release.renew(),
            maxAttempts: params.maxAttempts,
            pollIntervalMs: params.pollIntervalMs,
            sleep,
            onStateTransition: params.onStateTransition,
          });

          if (claimResolution === 'claim-cleared') {
            continue;
          }

          return claimResolution;
        }
      } finally {
        await release();
      }
    }

    const suggestionState = await params.getState();

    if (isHandledSuggestionState(suggestionState)) {
      await emitState(params.onStateTransition, 'handled');
      return 'handled';
    }

    if (attempt === params.maxAttempts) {
      break;
    }

    await sleep(params.pollIntervalMs);
  }

  await emitState(params.onStateTransition, 'timed-out');
  return 'timed-out';
}
