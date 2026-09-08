import { workerClient } from '@roomote/sdk/client';
import type { ManageIntegrationConnectionInput } from '@roomote/types';
import { errorResult, jsonResult } from './tool-result.js';

export async function handleManageIntegrationConnection(
  input: ManageIntegrationConnectionInput,
) {
  try {
    return jsonResult(
      await workerClient.mcpConnections.manageConnection.mutate(input),
    );
  } catch {
    return {
      ...errorResult(
        'Integration connection operation failed. Admin access and valid input are required.',
      ),
      isError: true,
    };
  }
}
