import {
  resolveBrainConnection,
  resolveBrainInferenceProvider,
} from '@roomote/sdk/server';

const BRAIN_MAINTENANCE_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Ask gbrain's durable Postgres worker to run one built-in maintenance cycle.
 * Roomote owns the clock so hosted and self-hosted deployments behave alike;
 * gbrain owns the maintenance algorithm and its cycle locking.
 */
export async function brainMaintenanceJob(): Promise<void> {
  const provider = await resolveBrainInferenceProvider();

  if (!provider) {
    return;
  }

  const connection = await resolveBrainConnection('maintenance');

  if (!connection) {
    return;
  }

  const response = await fetch(`${connection.baseUrl.replace(/\/$/, '')}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${connection.token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'submit_job',
        arguments: {
          name: 'autopilot-cycle',
          data: { pull: false },
          max_attempts: 2,
          timeout_ms: BRAIN_MAINTENANCE_TIMEOUT_MS,
        },
      },
    }),
  });
  const body = await response.text().catch(() => '');

  if (!response.ok || /"isError"\s*:\s*true/.test(body)) {
    throw new Error(
      `gbrain maintenance submission failed: ${response.status} ${body.slice(0, 300)}`,
    );
  }
}
