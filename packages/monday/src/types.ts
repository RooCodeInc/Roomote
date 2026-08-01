import { z } from 'zod';

const mondayAgentTargetPayloadSchema = z
  .object({
    text: z.string(),
    itemId: z.union([z.string(), z.number()]).transform(String),
    boardId: z.union([z.string(), z.number()]).transform(String),
    groupId: z.string().nullable().optional(),
    updateId: z
      .union([z.string(), z.number()])
      .transform(String)
      .nullable()
      .optional(),
    replyId: z
      .union([z.string(), z.number()])
      .transform(String)
      .nullable()
      .optional(),
    updateBody: z.string().nullable().optional(),
    files: z.array(z.unknown()).nullable().optional(),
  })
  .strict();

const mondayAgentChatPayloadSchema = z
  .object({
    text: z.string(),
  })
  .strict();

export const mondayAgentTriggerSchema = z.discriminatedUnion('triggerType', [
  z
    .object({
      event: z.literal('agent_triggered'),
      triggerType: z.literal('chat'),
      payload: mondayAgentChatPayloadSchema,
      timestamp: z.string().datetime(),
      stream: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      event: z.literal('agent_triggered'),
      triggerType: z.literal('assigned'),
      payload: mondayAgentTargetPayloadSchema,
      timestamp: z.string().datetime(),
      stream: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      event: z.literal('agent_triggered'),
      triggerType: z.literal('mention'),
      payload: mondayAgentTargetPayloadSchema,
      timestamp: z.string().datetime(),
      stream: z.boolean().optional(),
    })
    .strict(),
]);

export const mondayWebhookChallengeSchema = z
  .object({
    challenge: z.string().min(1),
  })
  .strict();

export type MondayAgentTrigger = z.infer<typeof mondayAgentTriggerSchema>;

export type MondayAccount = {
  id: string;
  name: string;
  slug: string | null;
};

export type MondayExternalAgentCredentials = {
  agentId: string;
  apiToken: string;
  signingSecret: string;
  instructions: string | null;
};

export type MondayItemContext = {
  id: string;
  name: string;
  board: { id: string; name: string } | null;
  updates: Array<{
    id: string;
    body: string;
    createdAt: string;
    creator: { id: string; name: string } | null;
  }>;
};
