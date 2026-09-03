import { getDelegatedTaskDetails } from './delegated-task';

function toolResult(toolName: string, output: unknown) {
  return {
    kind: 'tool_result',
    data: {
      toolName,
      output: JSON.stringify(output),
      rawInput: { arguments: { prompt: 'Review this' } },
    },
  } as never;
}

describe('getDelegatedTaskDetails', () => {
  it('extracts the task from a launch_task result', () => {
    expect(
      getDelegatedTaskDetails(
        toolResult('launch_task', { success: true, taskId: 'task-1' }),
      ),
    ).toEqual({ taskId: 'task-1', prompt: 'Review this' });
  });

  it('extracts the task from a review_pull_request result', () => {
    expect(
      getDelegatedTaskDetails(
        toolResult('review_pull_request', { success: true, taskId: 'task-1' }),
      ),
    ).toEqual({ taskId: 'task-1', prompt: 'Review this' });
  });

  it('renders no card for a reused already-running review', () => {
    expect(
      getDelegatedTaskDetails(
        toolResult('review_pull_request', {
          success: true,
          taskId: 'task-1',
          alreadyRunning: true,
        }),
      ),
    ).toBeNull();
  });

  it('ignores results from other tools', () => {
    expect(
      getDelegatedTaskDetails(
        toolResult('send_task_message', { success: true, taskId: 'task-1' }),
      ),
    ).toBeNull();
  });
});
