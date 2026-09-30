import { TaskPayloadKind } from '@roomote/types';

import { withAutomationScanReplyPolicy } from '../automation-scan-chat-policy';

describe('withAutomationScanReplyPolicy', () => {
  it.each([
    {
      label: 'scheduled automation scan',
      taskType: TaskPayloadKind.Scan,
      workflow: 'scan',
      initiatorKind: 'automation',
      trigger: 'schedule',
      shouldSuppress: true,
    },
    {
      label: 'manual trigger of an automation scan',
      taskType: TaskPayloadKind.Scan,
      workflow: 'scan',
      initiatorKind: 'automation',
      trigger: 'manual',
      shouldSuppress: true,
    },
    {
      label: 'user-started scan',
      taskType: TaskPayloadKind.Scan,
      workflow: 'scan',
      initiatorKind: 'user',
      trigger: 'manual',
      shouldSuppress: false,
    },
    {
      label: 'spawned StandardTask execution',
      taskType: TaskPayloadKind.StandardTask,
      workflow: 'standard',
      initiatorKind: 'automation',
      trigger: 'schedule',
      shouldSuppress: false,
    },
  ])('classifies $label', (testCase) => {
    const input = {
      task: {
        type: testCase.taskType,
        payload: { repo: 'acme/widgets', description: 'Inspect follow-ups' },
      },
      workflow: testCase.workflow,
      initiator: { kind: testCase.initiatorKind },
      trigger: testCase.trigger,
    };

    const result = withAutomationScanReplyPolicy(input);

    if (testCase.shouldSuppress) {
      expect(result).not.toBe(input);
      expect(result.task.payload).toMatchObject({
        suppressNonTerminalRepliesWithoutTurn: true,
      });
      expect(input.task.payload).not.toHaveProperty(
        'suppressNonTerminalRepliesWithoutTurn',
      );
    } else {
      expect(result).toBe(input);
      expect(result.task.payload).not.toHaveProperty(
        'suppressNonTerminalRepliesWithoutTurn',
      );
    }
  });
});
