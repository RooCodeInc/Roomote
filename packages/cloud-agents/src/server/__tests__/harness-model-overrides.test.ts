import {
  type TaskSpec,
  TaskPayloadKind,
  DEFAULT_TASK_MODEL_SETTINGS,
  getDefaultTaskModelId,
} from '@roomote/types';
import { describe, expect, it } from 'vitest';

import { resolveEffectiveHarnessModelState } from '../harness-model-overrides';

function makeTask(
  harnessModelOverrides?: TaskSpec['payload']['harnessModelOverrides'],
  type: TaskPayloadKind = TaskPayloadKind.StandardTask,
): TaskSpec {
  return {
    type,
    payload: {
      ...(harnessModelOverrides ? { harnessModelOverrides } : {}),
    },
  } as unknown as TaskSpec;
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
        'opencode-server': 'openrouter/openai/gpt-5.6-terra',
      }),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
    });

    expect(model).toBe('openrouter/openai/gpt-5.6-terra');
  });

  it('uses the deployment code review model for PR review tasks when no override is present', () => {
    const { model, task } = resolveEffectiveHarnessModelState({
      task: makeTask(undefined, TaskPayloadKind.GithubPrReview),
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
      task: makeTask(undefined, TaskPayloadKind.GithubPrReviewSync),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
      deploymentCodeReviewModelId: 'openrouter/z-ai/glm-5.2',
    });

    expect(model).toBe('openrouter/z-ai/glm-5.2');
  });

  it('uses the default coding model for PR review follow-up tasks', () => {
    const { model } = resolveEffectiveHarnessModelState({
      task: makeTask(undefined, TaskPayloadKind.GithubPrReviewFollowUp),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
      deploymentCodeReviewModelId: 'openrouter/z-ai/glm-5.2',
    });

    expect(model).toBe(getDefaultTaskModelId(DEFAULT_TASK_MODEL_SETTINGS));
  });

  it('falls back to the default task model for PR review tasks when no code review model is configured', () => {
    const { model } = resolveEffectiveHarnessModelState({
      task: makeTask(undefined, TaskPayloadKind.GithubPrReview),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
    });

    expect(model).toBe(getDefaultTaskModelId(DEFAULT_TASK_MODEL_SETTINGS));
  });

  it('keeps an explicit harness model override even for PR review tasks', () => {
    const { model } = resolveEffectiveHarnessModelState({
      task: makeTask(
        { 'opencode-server': 'openrouter/openai/gpt-5.6-terra' },
        TaskPayloadKind.GithubPrReview,
      ),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
      deploymentCodeReviewModelId: 'openrouter/z-ai/glm-5.2',
    });

    expect(model).toBe('openrouter/openai/gpt-5.6-terra');
  });

  it('stamps the default coding reasoning effort for a model override', () => {
    const { task } = resolveEffectiveHarnessModelState({
      task: makeTask({
        'opencode-server': 'openrouter/openai/gpt-5.6-terra',
      }),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
    });

    expect(task.payload.reasoningEffort).toBe('medium');
  });

  it('inherits the deployment coding reasoning effort for a model override', () => {
    const { task } = resolveEffectiveHarnessModelState({
      task: makeTask({
        'opencode-server': 'openrouter/openai/gpt-5.6-terra',
      }),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
      deploymentCodingReasoningEffort: 'xhigh',
    });

    expect(task.payload.reasoningEffort).toBe('xhigh');
  });

  it('keeps an explicit per-task reasoning effort over the deployment level', () => {
    const task = makeTask({
      'opencode-server': 'openrouter/openai/gpt-5.6-terra',
    });
    task.payload.reasoningEffort = 'low';

    const { task: nextTask } = resolveEffectiveHarnessModelState({
      task,
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
      deploymentCodingReasoningEffort: 'xhigh',
    });

    expect(nextTask.payload.reasoningEffort).toBe('low');
  });

  it('does not stamp a reasoning effort for models without reasoning support', () => {
    const { task } = resolveEffectiveHarnessModelState({
      task: makeTask({
        'opencode-server': 'openrouter/custom/no-reasoning-model',
      }),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
      deploymentTaskModelSettings: {
        models: [
          {
            id: 'openrouter/custom/no-reasoning-model',
            displayName: 'No Reasoning Model',
            family: 'Custom',
            metadata: {
              contextWindow: null,
              inputTypes: null,
              inputPricePerToken: null,
              outputPricePerToken: null,
              lastRefreshedAt: null,
              supportsReasoning: false,
            },
          },
        ],
        allowedModelIds: ['openrouter/custom/no-reasoning-model'],
        defaultModelId: 'openrouter/custom/no-reasoning-model',
      },
    });

    expect(task.payload.reasoningEffort).toBeUndefined();
  });

  it('does not stamp a reasoning effort when the deployment default model is applied', () => {
    const { task } = resolveEffectiveHarnessModelState({
      task: makeTask(),
      targetHarness: 'opencode-server',
      isSnapshotResume: false,
    });

    expect(task.payload.reasoningEffort).toBeUndefined();
  });

  it('stamps a reasoning effort when reusing snapshot-resume model overrides', () => {
    const { task } = resolveEffectiveHarnessModelState({
      task: makeTask(),
      targetHarness: 'opencode-server',
      isSnapshotResume: true,
      sourceRunHarnessModelOverrides: {
        'opencode-server': 'openrouter/z-ai/glm-5.2',
      },
      sourceTaskType: TaskPayloadKind.GithubPrReview,
      deploymentCodingReasoningEffort: 'high',
      deploymentCodeReviewReasoningEffort: 'xhigh',
    });

    expect(task.payload.reasoningEffort).toBe('xhigh');
  });

  it('migrates a legacy OpenCode model override during snapshot resume', () => {
    const { model, task } = resolveEffectiveHarnessModelState({
      task: makeTask(),
      targetHarness: 'opencode-server',
      isSnapshotResume: true,
      sourceRunHarnessModelOverrides: {
        'opencode-server': 'opencode/deepseek-v4-flash-0731',
      },
    });

    expect(model).toBe('opencode/deepseek-v4-flash');
    expect(task.payload.harnessModelOverrides).toEqual({
      'opencode-server': 'opencode/deepseek-v4-flash',
    });
  });
});
