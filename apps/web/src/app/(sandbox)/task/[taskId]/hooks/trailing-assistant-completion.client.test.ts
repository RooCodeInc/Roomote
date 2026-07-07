import { CloudTaskStatus } from '@roomote/types';

import { shouldMarkTrailingAssistantCompletion } from './trailing-assistant-completion';

describe('shouldMarkTrailingAssistantCompletion', () => {
  it('does not treat an unknown running phase as a completed turn', () => {
    expect(
      shouldMarkTrailingAssistantCompletion({
        taskStatus: CloudTaskStatus.Running,
        taskPhase: null,
      }),
    ).toBe(false);
  });

  it('marks waiting phases as completed turns', () => {
    expect(
      shouldMarkTrailingAssistantCompletion({
        taskStatus: CloudTaskStatus.Running,
        taskPhase: 'waiting_for_prompt',
      }),
    ).toBe(true);

    expect(
      shouldMarkTrailingAssistantCompletion({
        taskStatus: CloudTaskStatus.Running,
        taskPhase: 'waiting_for_user_input',
      }),
    ).toBe(true);
  });

  it('marks successful legacy exits with no task phase as completed turns', () => {
    expect(
      shouldMarkTrailingAssistantCompletion({
        taskStatus: CloudTaskStatus.Completed,
        taskPhase: null,
      }),
    ).toBe(true);

    expect(
      shouldMarkTrailingAssistantCompletion({
        taskStatus: CloudTaskStatus.Idle,
        taskPhase: null,
      }),
    ).toBe(true);
  });

  it('does not mark failed or canceled transcripts as completed turns', () => {
    expect(
      shouldMarkTrailingAssistantCompletion({
        taskStatus: CloudTaskStatus.Failed,
        taskPhase: 'waiting_for_prompt',
      }),
    ).toBe(false);

    expect(
      shouldMarkTrailingAssistantCompletion({
        taskStatus: CloudTaskStatus.Canceled,
        taskPhase: null,
      }),
    ).toBe(false);
  });
});
