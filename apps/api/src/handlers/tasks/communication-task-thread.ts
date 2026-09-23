import { stripRecognizedInitialSkillInvocationsForTitle } from '@roomote/cloud-agents';
import { buildCommunicationTaskThreadName as buildThreadName } from '@roomote/communication/task-thread-title';

export { buildCommunicationTaskThreadName } from '@roomote/communication/task-thread-title';

export function buildCommunicationTaskPromptThreadName(
  prompt: string,
  maxLength?: number,
): string {
  return buildThreadName(
    stripRecognizedInitialSkillInvocationsForTitle(prompt),
    maxLength,
  );
}
