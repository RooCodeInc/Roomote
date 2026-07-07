import type { SlackBlock } from '@roomote/types';

export interface CancelTaskActionValue {
  taskId?: string;
  cloudJobId?: number;
  slackUserId?: string;
}

export const TASK_CANCELED_RESPONSE_TEXT = 'Started a task but cancelled.';
export const TASK_NOT_RUNNING_RESPONSE_TEXT = 'Task is no longer running.';

export function buildTaskCancellationResponseBlocks(
  text: string,
): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
    },
  ];
}

export function buildTaskNotRunningResponseBlocks(
  existingBlocks?: unknown[],
): SlackBlock[] {
  if (!Array.isArray(existingBlocks) || existingBlocks.length === 0) {
    return buildTaskCancellationResponseBlocks(TASK_NOT_RUNNING_RESPONSE_TEXT);
  }

  let replacedPrimarySection = false;

  const updatedBlocks = existingBlocks
    .map((block) => {
      if (!block || typeof block !== 'object') {
        return block;
      }

      const typedBlock = block as {
        type?: string;
        text?: { type?: string; text?: string };
        elements?: Array<{ action_id?: string }>;
      };

      if (
        !replacedPrimarySection &&
        typedBlock.type === 'section' &&
        typedBlock.text &&
        typeof typedBlock.text === 'object' &&
        typeof typedBlock.text.text === 'string'
      ) {
        replacedPrimarySection = true;
        return {
          ...typedBlock,
          text: {
            ...typedBlock.text,
            text: TASK_NOT_RUNNING_RESPONSE_TEXT,
          },
        };
      }

      if (typedBlock.type === 'actions' && Array.isArray(typedBlock.elements)) {
        const filteredElements = typedBlock.elements.filter(
          (element) => element.action_id !== 'cancel_task',
        );

        if (filteredElements.length === 0) {
          return null;
        }

        return {
          ...typedBlock,
          elements: filteredElements,
        };
      }

      return block;
    })
    .filter((block): block is SlackBlock => block !== null);

  return updatedBlocks.length > 0
    ? updatedBlocks
    : buildTaskCancellationResponseBlocks(TASK_NOT_RUNNING_RESPONSE_TEXT);
}

export function parseTaskCancellationActionValue(
  rawValue: string | null | undefined,
): CancelTaskActionValue | null {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const parsedObject = parsed as Partial<{
        taskId: string;
        cloudJobId: number | string;
        slackUserId: string;
      }>;
      const taskId =
        typeof parsedObject.taskId === 'string' &&
        parsedObject.taskId.trim().length > 0
          ? parsedObject.taskId
          : undefined;
      const cloudJobId =
        typeof parsedObject.cloudJobId === 'number'
          ? parsedObject.cloudJobId
          : Number.parseInt(parsedObject.cloudJobId ?? '', 10);

      if (!taskId && (!Number.isInteger(cloudJobId) || cloudJobId <= 0)) {
        return null;
      }

      return {
        ...(taskId ? { taskId } : {}),
        ...(Number.isInteger(cloudJobId) && cloudJobId > 0
          ? { cloudJobId }
          : {}),
        slackUserId:
          typeof parsedObject.slackUserId === 'string' &&
          parsedObject.slackUserId.length > 0
            ? parsedObject.slackUserId
            : undefined,
      };
    }
  } catch {
    return null;
  }

  return null;
}
