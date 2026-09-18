import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  desktopDeviceActionSchema,
  desktopDeviceRequestSchema,
} from '@roomote/types';
import {
  listDesktopDevices,
  recordDesktopDeviceAudit,
  revokeDesktopDevice,
} from '@roomote/db/server';

import {
  DesktopBrokerError,
  getDesktopDeviceBroker,
} from '../desktop-devices/broker';
import { toolError } from './in-process-api';
import { toMcpToolResult } from './proxy-utils';

export function registerRoomoteDesktopTools(
  server: McpServer,
  ownerUserId: string,
): void {
  server.registerTool(
    'desktop_devices',
    {
      title: 'Manage Desktop Devices',
      description:
        'List, disconnect, or revoke desktop devices owned by the current user. Disconnect ends the live connection and stops local input. Revoke also prevents the device identity from reconnecting.',
      inputSchema: {
        action: z.enum(['list', 'disconnect', 'revoke']),
        deviceId: z.string().uuid().optional(),
        reason: z.string().trim().min(1).max(200).optional(),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ action, deviceId, reason }) => {
      const broker = getDesktopDeviceBroker();
      if (action === 'list') {
        const devices = await listDesktopDevices(ownerUserId);
        return toMcpToolResult({
          devices: devices.map((device) => ({
            ...device,
            online: broker.isOnline(ownerUserId, device.id),
            routedElsewhere:
              !broker.isOnline(ownerUserId, device.id) &&
              device.lastInstanceId != null &&
              device.lastInstanceId !== broker.instanceId,
          })),
        });
      }
      if (!deviceId)
        return toolError({ error: `deviceId is required for ${action}` });
      const owned = (await listDesktopDevices(ownerUserId)).some(
        (device) => device.id === deviceId,
      );
      if (!owned) return toolError({ error: 'Desktop device not found' });

      if (action === 'disconnect') {
        const disconnected = broker.disconnect(ownerUserId, deviceId);
        return toMcpToolResult({ deviceId, disconnected });
      }

      const revoked = await revokeDesktopDevice({
        ownerUserId,
        deviceId,
        actorUserId: ownerUserId,
        ...(reason ? { reason } : {}),
      });
      if (revoked) {
        await recordDesktopDeviceAudit({
          deviceId,
          ownerUserId,
          actorUserId: ownerUserId,
          event: 'revoked',
          outcome: 'revoked',
        });
      }
      broker.revoke(ownerUserId, deviceId);
      return toMcpToolResult({ deviceId, revoked });
    },
  );

  server.registerTool(
    'desktop_request',
    {
      title: 'Call Desktop Device',
      description:
        'Call one bounded desktop action on a device owned by the current user. This tool cannot arm input. Type and submit require an unexpired target grant approved locally on the Mac and allowInput=true on this request.',
      inputSchema: {
        deviceId: z.string().uuid().optional(),
        action: desktopDeviceActionSchema,
        limit: z.number().int().min(1).max(500).optional(),
        displayId: z.number().int().positive().optional(),
        windowId: z.number().int().positive().optional(),
        pid: z.number().int().positive().optional(),
        path: z.string().min(1).max(500).optional(),
        text: z.string().max(10_000).optional(),
        mode: z.enum(['append', 'replace']).optional(),
        maxElements: z.number().int().min(1).max(500).optional(),
        maxDepth: z.number().int().min(1).max(12).optional(),
        allowInput: z.boolean().optional(),
      },
      outputSchema: z.object({}).passthrough(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const broker = getDesktopDeviceBroker();
      const devices = await listDesktopDevices(ownerUserId);
      const online = devices.filter(
        (device) =>
          !device.revokedAt && broker.isOnline(ownerUserId, device.id),
      );
      const deviceId =
        input.deviceId ?? (online.length === 1 ? online[0]!.id : undefined);
      if (!deviceId) {
        return toolError({
          error:
            online.length === 0
              ? 'No desktop device is online'
              : 'deviceId is required when more than one desktop device is online',
        });
      }
      const selectedDevice = devices.find(
        (device) => device.id === deviceId && !device.revokedAt,
      );
      if (!selectedDevice)
        return toolError({ error: 'Desktop device not found' });
      if (
        !broker.isOnline(ownerUserId, deviceId) &&
        selectedDevice.lastInstanceId != null &&
        selectedDevice.lastInstanceId !== broker.instanceId
      ) {
        return toolError({
          error:
            'device_on_other_instance: desktop routing across API replicas is not available yet',
        });
      }
      const { deviceId: _deviceId, ...wireInput } = input;
      const parsed = desktopDeviceRequestSchema.safeParse(wireInput);
      if (!parsed.success) {
        return toolError({
          error: parsed.error.issues[0]?.message ?? 'Invalid desktop request',
        });
      }
      try {
        return await broker.request(ownerUserId, deviceId, parsed.data);
      } catch (error) {
        return toolError({
          error:
            error instanceof DesktopBrokerError
              ? `${error.code}: ${error.message}`
              : 'Desktop request failed',
        });
      }
    },
  );
}
