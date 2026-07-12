import { RunStatus } from '@roomote/types';

import type { WorkerEnv } from './env';

function outcomeForStatus(
  status: RunStatus,
): 'completed' | 'failed' | 'canceled' {
  if (status === RunStatus.Completed || status === RunStatus.Idle)
    return 'completed';
  if (status === RunStatus.Canceled) return 'canceled';
  return 'failed';
}

export async function closeManagedRuntime(input: {
  workerEnv: WorkerEnv;
  status: RunStatus;
  fetchFn?: typeof fetch;
}): Promise<void> {
  const env = input.workerEnv.getManagedRuntimeEnv();
  const baseUrl = env.ROOMOTE_CLOUD_SESSION_URL?.replace(/\/+$/u, '');
  const reservationId = env.ROOMOTE_CLOUD_RESERVATION_ID;
  const token = env.ROOMOTE_CLOUD_INFERENCE_TOKEN;
  if (!baseUrl && !reservationId && !token) return;
  if (!baseUrl || !reservationId || !token) {
    console.warn('[managed-runtime] Session close skipped: partial config');
    return;
  }
  const response = await (input.fetchFn ?? fetch)(
    `${baseUrl}/runtime/v1/sessions/${encodeURIComponent(reservationId)}/close`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        outcome: outcomeForStatus(input.status),
        platformFault: false,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Managed runtime close failed (${response.status})`);
  }
}
