import { describe, expect, it } from 'vitest';

import {
  BACKGROUND_AUTOMATION_KEYS,
  CloudTaskType,
  TASK_SUGGESTION_SOURCES,
  getTriggerableBackgroundAutomationDescriptorByKey,
  isKnownAutomationTaskType,
  resolveTaskAutomationDisplayName,
} from '../index';

describe('resolveTaskAutomationDisplayName', () => {
  it('names every scheduled suggestion source distinctly', () => {
    const labels = TASK_SUGGESTION_SOURCES.map((suggestionSource) =>
      resolveTaskAutomationDisplayName({
        type: CloudTaskType.SuggestedTasks,
        payload: { suggestionSource },
      }),
    );

    for (const label of labels) {
      expect(label).toBeTruthy();
    }

    // Every suggestion source must resolve to its own automation series so a
    // newly added automation cannot silently reuse another automation's name.
    expect(new Set(labels).size).toBe(TASK_SUGGESTION_SOURCES.length);

    // Labels are embedded in the PR-body attribution line ("> Created by
    // <label>.") which is re-detected with a sentence-bounded regex in
    // reviewTaskRelayPayload.ts, so labels must stay free of periods and
    // newlines.
    for (const label of labels) {
      expect(label).not.toMatch(/[.\n]/);
    }
  });

  it('names every triggerable background automation key it is given', () => {
    for (const automationKey of BACKGROUND_AUTOMATION_KEYS) {
      const descriptor =
        getTriggerableBackgroundAutomationDescriptorByKey(automationKey);

      if (!descriptor) {
        continue;
      }

      expect(descriptor.label).not.toMatch(/[.\n]/);

      expect(
        resolveTaskAutomationDisplayName({
          type: CloudTaskType.StandardTask,
          payload: { automationKey },
        }),
      ).toBe(descriptor.label);
    }
  });

  it('names PR review and conflict-resolution task types', () => {
    expect(
      resolveTaskAutomationDisplayName({
        type: CloudTaskType.GithubPrReview,
      }),
    ).toBe('PR Reviewer');
    expect(
      resolveTaskAutomationDisplayName({
        type: CloudTaskType.GithubPrReviewSync,
      }),
    ).toBe('PR Reviewer');
    expect(
      resolveTaskAutomationDisplayName({
        type: CloudTaskType.GithubPrReviewFollowUp,
      }),
    ).toBe('PR Reviewer');
    expect(
      resolveTaskAutomationDisplayName({
        type: CloudTaskType.GithubPrConflictResolve,
      }),
    ).toBe('Resolve PR Conflicts');
  });

  it('returns null for human-initiated task types without automation hints', () => {
    expect(
      resolveTaskAutomationDisplayName({
        type: CloudTaskType.StandardTask,
        payload: {},
      }),
    ).toBeNull();
    expect(
      resolveTaskAutomationDisplayName({
        type: CloudTaskType.SlackAppMention,
        payload: {},
      }),
    ).toBeNull();
  });
});

describe('isKnownAutomationTaskType', () => {
  it('covers automation-only task types and excludes human entry points', () => {
    expect(isKnownAutomationTaskType(CloudTaskType.GithubPrReview)).toBe(true);
    expect(
      isKnownAutomationTaskType(CloudTaskType.GithubPrConflictResolve),
    ).toBe(true);
    expect(isKnownAutomationTaskType(CloudTaskType.SuggestedTasks)).toBe(true);
    expect(isKnownAutomationTaskType(CloudTaskType.StandardTask)).toBe(false);
    expect(isKnownAutomationTaskType(CloudTaskType.SlackAppMention)).toBe(
      false,
    );
    expect(isKnownAutomationTaskType(CloudTaskType.LinearAgentSession)).toBe(
      false,
    );
  });
});
