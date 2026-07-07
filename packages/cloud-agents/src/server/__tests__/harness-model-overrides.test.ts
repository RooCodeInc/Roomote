import {
  type CloudTask,
  CloudTaskType,
  DEFAULT_TASK_MODEL_SETTINGS,
  getDefaultTaskModelId,
} from '@roomote/types';
import { describe, expect, it } from 'vitest';

import { resolveEffectiveHarnessModelState } from '../harness-model-overrides';

function makeTask(
  harnessModelOverrides?: CloudTask['payload']['harnessModelOverrides'],
  type: CloudTaskType = CloudTaskType.StandardTask,
): CloudTask {
  return {
    type,
    payload: {
      ...(harnessModelOverrides ? { harnessModelOverrides } : {}),
    },
  } as unknown as CloudTask;
}

describe('resolveEffectiveHarnessModelState', () => {
  it('falls back to the current deployment default model when no OpenCode override is present', () => {
    const { model, task } = resolveEffectiveHarnessModelState({
      task: makeTask(),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
    });

    expect(model).toBe(getDefaultTaskModelId(DEFAULT_TASK_MODEL_SETTINGS));
    expect(task.payload.harnessModelOverrides).toEqual({
      'opencode-server': getDefaultTaskModelId(DEFAULT_TASK_MODEL_SETTINGS),
    });
  });

  it('resolves the persisted model from an OpenCode harness override', () => {
    const { model } = resolveEffectiveHarnessModelState({
      task: makeTask({
        'opencode-server': 'openrouter/z-ai/glm-5.2',
      }),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
    });

    expect(model).toBe('openrouter/z-ai/glm-5.2');
  });

  it('uses the deployment code review model for PR review tasks when no override is present', () => {
    const { model, task } = resolveEffectiveHarnessModelState({
      task: makeTask(undefined, CloudTaskType.GithubPrReview),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
      deploymentCodeReviewModelId: 'openrouter/z-ai/glm-5.2',
    });

    expect(model).toBe('openrouter/z-ai/glm-5.2');
    expect(task.payload.harnessModelOverrides).toEqual({
      'opencode-server': 'openrouter/z-ai/glm-5.2',
    });
  });

  it('uses the deployment code review model for PR review sync tasks', () => {
    const { model } = resolveEffectiveHarnessModelState({
      task: makeTask(undefined, CloudTaskType.GithubPrReviewSync),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
      deploymentCodeReviewModelId: 'openrouter/z-ai/glm-5.2',
    });

    expect(model).toBe('openrouter/z-ai/glm-5.2');
  });

  it('uses the default coding model for PR review follow-up tasks', () => {
    const { model } = resolveEffectiveHarnessModelState({
      task: makeTask(undefined, CloudTaskType.GithubPrReviewFollowUp),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
      deploymentCodeReviewModelId: 'openrouter/z-ai/glm-5.2',
    });

    expect(model).toBe(getDefaultTaskModelId(DEFAULT_TASK_MODEL_SETTINGS));
  });

  it('falls back to the default task model for PR review tasks when no code review model is configured', () => {
    const { model } = resolveEffectiveHarnessModelState({
      task: makeTask(undefined, CloudTaskType.GithubPrReview),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
    });

    expect(model).toBe(getDefaultTaskModelId(DEFAULT_TASK_MODEL_SETTINGS));
  });

  it('keeps an explicit harness model override even for PR review tasks', () => {
    const { model } = resolveEffectiveHarnessModelState({
      task: makeTask(
        { 'opencode-server': 'openrouter/openai/gpt-5.4' },
        CloudTaskType.GithubPrReview,
      ),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
      deploymentCodeReviewModelId: 'openrouter/z-ai/glm-5.2',
    });

    expect(model).toBe('openrouter/openai/gpt-5.4');
  });
});
