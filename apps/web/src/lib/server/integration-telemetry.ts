import { captureEvent } from '@roomote/telemetry/server';

type IntegrationLifecycleEvent =
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

export function captureIntegrationConnectionTransitions(input: {
  integrationId: string;
  userId: string;
  connected: boolean;
  enabled: boolean;
}): void {
  if (input.connected) {
    captureIntegrationLifecycleEvent(
      'integration_connected',
      input.integrationId,
      input.userId,
    );
  }
  if (input.enabled) {
    captureIntegrationLifecycleEvent(
      'integration_enabled',
      input.integrationId,
      input.userId,
    );
  }
}
