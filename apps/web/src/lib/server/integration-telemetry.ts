import { captureEvent } from '@roomote/telemetry/server';

export type IntegrationLifecycleEvent =
  | 'integration_connected'
  | 'integration_disabled'
  | 'integration_enabled'
  | 'integration_removed';

export function captureIntegrationLifecycleEvent(
  event: IntegrationLifecycleEvent,
  integrationId: string,
  userId?: string,
): void {
  void captureEvent(event, {
    ...(userId ? { userId } : {}),
    properties: { integration_id: integrationId },
  });
}
