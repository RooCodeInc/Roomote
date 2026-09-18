import { z } from 'zod';

export const DESKTOP_DEVICE_PROTOCOL_VERSION = 1;
export const DESKTOP_DEVICE_MAX_REQUEST_BYTES = 1024 * 1024;
export const DESKTOP_DEVICE_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
export const DESKTOP_DEVICE_REQUEST_TIMEOUT_MS = 30_000;
export const DESKTOP_DEVICE_CAPTURE_TIMEOUT_MS = 60_000;

export const desktopDeviceActionSchema = z.enum([
  'doctor',
  'displays',
  'windows',
  'capture',
  'inspect',
  'type',
  'submit',
  'status',
  'stop',
  'disarm',
]);
export type DesktopDeviceAction = z.infer<typeof desktopDeviceActionSchema>;

const positiveInteger = z.number().int().positive();

export const desktopDeviceRequestSchema = z.union([
  z.object({ action: z.literal('doctor') }).strict(),
  z.object({ action: z.literal('displays') }).strict(),
  z
    .object({
      action: z.literal('windows'),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('capture'),
      displayId: positiveInteger.optional(),
      windowId: positiveInteger.optional(),
    })
    .strict()
    .refine(
      (value) =>
        (value.displayId === undefined) !== (value.windowId === undefined),
      'Capture requires exactly one displayId or windowId',
    ),
  z
    .object({
      action: z.literal('inspect'),
      pid: positiveInteger,
      maxElements: z.number().int().min(1).max(500).optional(),
      maxDepth: z.number().int().min(1).max(12).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('type'),
      pid: positiveInteger,
      path: z.string().min(1).max(500),
      text: z.string().max(10_000),
      mode: z.enum(['append', 'replace']).optional(),
      allowInput: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal('submit'),
      pid: positiveInteger,
      path: z.string().min(1).max(500),
      allowInput: z.literal(true),
    })
    .strict(),
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('stop') }).strict(),
  z.object({ action: z.literal('disarm') }).strict(),
]);
export type DesktopDeviceRequest = z.infer<typeof desktopDeviceRequestSchema>;

export const desktopDeviceHelloSchema = z
  .object({
    type: z.literal('hello'),
    protocolVersion: z.literal(DESKTOP_DEVICE_PROTOCOL_VERSION),
    device: z.object({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(200),
      platform: z.string().trim().min(1).max(50),
    }),
    capabilities: z.array(desktopDeviceActionSchema).max(20),
  })
  .strict();
export type DesktopDeviceHello = z.infer<typeof desktopDeviceHelloSchema>;

const desktopTextContentSchema = z
  .object({
    type: z.literal('text'),
    text: z.string().max(DESKTOP_DEVICE_MAX_REQUEST_BYTES),
  })
  .strict();
const desktopImageContentSchema = z
  .object({
    type: z.literal('image'),
    data: z.string().max(16 * 1024 * 1024),
    mimeType: z.literal('image/png'),
  })
  .strict();

export const desktopDeviceToolResultSchema = z
  .object({
    content: z
      .array(z.union([desktopTextContentSchema, desktopImageContentSchema]))
      .min(1)
      .max(2),
    structuredContent: z.record(z.unknown()),
    isError: z.boolean().optional(),
  })
  .strict();
export type DesktopDeviceToolResult = z.infer<
  typeof desktopDeviceToolResultSchema
>;

export const desktopDeviceClientMessageSchema = z.discriminatedUnion('type', [
  desktopDeviceHelloSchema,
  z
    .object({
      type: z.literal('response'),
      id: z.string().uuid(),
      result: desktopDeviceToolResultSchema,
    })
    .strict(),
  z
    .object({ type: z.literal('protocol_error'), error: z.string().max(1_000) })
    .strict(),
]);

export type DesktopDeviceAuditEvent =
  | 'connected'
  | 'disconnected'
  | 'rejected'
  | 'protocol_error'
  | 'request'
  | 'revoked'
  | 'revoke_delivered'
  | 'superseded';

export type DesktopDeviceAuditOutcome =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'offline'
  | 'busy'
  | 'revoked';
