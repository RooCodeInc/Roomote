import { z } from 'zod';

export const ROOMOTE_SESSION_COMMUNICATION_ACTIONS = [
  'get_messages',
  'send_message',
] as const;

export const roomoteSessionCommunicationFieldSchemas = {
  sessionId: z
    .string()
    .optional()
    .describe('The Fast session ID (required for all actions)'),
  message: z
    .string()
    .optional()
    .describe('Follow-up message text (required for send_message)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      'Maximum messages to return for get_messages (1 to 1000; newest first)',
    ),
} satisfies Record<string, z.ZodTypeAny>;

export const roomoteSessionCommunicationArgsSchema = z
  .object({
    action: z.enum(ROOMOTE_SESSION_COMMUNICATION_ACTIONS),
    ...roomoteSessionCommunicationFieldSchemas,
  })
  .strict();

export type RoomoteSessionCommunicationArgs = z.infer<
  typeof roomoteSessionCommunicationArgsSchema
>;
