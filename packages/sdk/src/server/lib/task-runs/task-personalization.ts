import { buildUserPersonalizationInstructions } from '@roomote/cloud-agents/server';
import { getUserPersonalizationRuntimeContext } from '@roomote/db/server';
import { TaskPayloadKind, type TaskInitiatorKind } from '@roomote/types';

const EXCLUDED_PAYLOADS = new Set<TaskPayloadKind>([
  TaskPayloadKind.Scan,
  TaskPayloadKind.McpRecommendations,
  TaskPayloadKind.SnapshotEnvironment,
]);

export async function getPrivateTaskPersonalizationInstructions(input: {
  actingUserId: string | null;
  initiatorKind: TaskInitiatorKind;
  payloadKind: TaskPayloadKind;
}): Promise<string> {
  if (
    !input.actingUserId ||
    input.initiatorKind !== 'user' ||
    EXCLUDED_PAYLOADS.has(input.payloadKind)
  ) {
    return '';
  }

  try {
    const context = await getUserPersonalizationRuntimeContext(
      input.actingUserId,
    );
    return buildUserPersonalizationInstructions(context, {
      updateToolName: 'roomote_update_personalization',
    });
  } catch (error) {
    console.warn(
      `[Task Personalization] Private context unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return '';
  }
}

export function appendPrivateTaskPersonalization(
  harnessInstructions: string | undefined,
  privateInstructions: string,
): string | undefined {
  if (!privateInstructions) return harnessInstructions;
  return harnessInstructions
    ? `${harnessInstructions}\n\n${privateInstructions}`
    : privateInstructions;
}
