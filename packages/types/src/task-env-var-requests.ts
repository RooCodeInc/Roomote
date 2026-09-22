import { z } from 'zod';

import { deploymentEnvVarNameSchema } from './environment-variables';
import { asBoolean, asRecord, asString } from './primitives';

export const taskEnvVarCredentialAccessSchema = z.object({
  operation: z
    .enum(['read', 'write'])
    .describe(
      'Whether the credential needs read-only access or permission to make changes',
    ),
  scope: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      'The provider project, team, account, or other resource boundary the credential must access',
    ),
  permissions: z
    .array(z.string().trim().min(1).max(200))
    .max(20)
    .optional()
    .describe(
      'Exact provider permission or scope names, included only when verified in provider documentation',
    ),
  documentationUrl: z
    .string()
    .url()
    .refine((value) => new URL(value).protocol === 'https:', {
      message: 'Documentation URL must use HTTPS',
    })
    .optional()
    .describe('Optional provider token-creation or permission documentation'),
});

export const taskEnvVarRequestVariableSchema = z.object({
  name: deploymentEnvVarNameSchema,
  purpose: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .optional()
    .describe('A concise description of what this variable unblocks'),
  credentialAccess: taskEnvVarCredentialAccessSchema
    .optional()
    .describe(
      'Required access for a credential or token. Omit for noncredential environment variables.',
    ),
});

export type TaskEnvVarRequestVariable = z.output<
  typeof taskEnvVarRequestVariableSchema
>;

export const createTaskEnvVarRequestBaseSchema = z.object({
  variables: z
    .array(taskEnvVarRequestVariableSchema)
    .min(1, 'At least one environment variable is required')
    .max(10, 'A maximum of 10 environment variables can be requested'),
});

export const createTaskEnvVarRequestSchema =
  createTaskEnvVarRequestBaseSchema.superRefine((value, ctx) => {
    const seen = new Set<string>();

    for (const [index, variable] of value.variables.entries()) {
      if (seen.has(variable.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['variables', index, 'name'],
          message: `Duplicate environment variable name: ${variable.name}`,
        });
      }

      seen.add(variable.name);
    }
  });

export type CreateTaskEnvVarRequestInput = z.infer<
  typeof createTaskEnvVarRequestSchema
>;

export const REQUEST_ENVIRONMENT_VARIABLES_TOOL_NAME =
  'request_environment_variables';

const taskEnvVarRequestToolResultSchema = z.object({
  success: z.literal(true),
  requestedNames: z.array(deploymentEnvVarNameSchema),
  requestedVariables: z.array(taskEnvVarRequestVariableSchema).optional(),
});

export const ENV_VAR_REQUEST_FULFILLED_CLIENT_MESSAGE_ID_PREFIX =
  'env-var-request-fulfilled:';

export function isEnvVarRequestFulfillmentClientMessageId(
  clientMessageId: string | null | undefined,
): boolean {
  return (
    typeof clientMessageId === 'string' &&
    clientMessageId.startsWith(
      ENV_VAR_REQUEST_FULFILLED_CLIENT_MESSAGE_ID_PREFIX,
    )
  );
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function unwrapTaskEnvVarRequestToolResult(value: unknown): unknown {
  const parsedResult = taskEnvVarRequestToolResultSchema.safeParse(value);

  if (parsedResult.success) {
    return parsedResult.data;
  }

  const record = asRecord(value);

  if (!record) {
    return value;
  }

  const structuredContentResult = taskEnvVarRequestToolResultSchema.safeParse(
    record.structuredContent,
  );

  if (structuredContentResult.success) {
    return structuredContentResult.data;
  }

  const content = record.content;

  if (!Array.isArray(content)) {
    return value;
  }

  for (const block of content) {
    const text = asString(asRecord(block)?.text);

    if (!text) {
      continue;
    }

    const parsedBlock = tryParseJson(text);

    if (!parsedBlock) {
      continue;
    }

    const unwrappedBlock = unwrapTaskEnvVarRequestToolResult(parsedBlock);
    const blockResult =
      taskEnvVarRequestToolResultSchema.safeParse(unwrappedBlock);

    if (blockResult.success) {
      return blockResult.data;
    }
  }

  return value;
}

export function getRequestedDeploymentEnvVarsFromToolPayload(
  payload: Record<string, unknown> | null | undefined,
): TaskEnvVarRequestVariable[] {
  const resolvedPayload = asRecord(payload);

  if (!resolvedPayload || asBoolean(resolvedPayload.isMcp) !== true) {
    return [];
  }

  const toolName =
    asString(resolvedPayload.toolName) ?? asString(resolvedPayload.mcpToolName);

  if (toolName !== REQUEST_ENVIRONMENT_VARIABLES_TOOL_NAME) {
    return [];
  }

  const output = asString(resolvedPayload.output);

  if (!output) {
    return [];
  }

  const parsed = tryParseJson(output);

  if (!parsed) {
    return [];
  }

  const result = taskEnvVarRequestToolResultSchema.safeParse(
    unwrapTaskEnvVarRequestToolResult(parsed),
  );

  if (!result.success) {
    return [];
  }

  const variables =
    result.data.requestedVariables ??
    result.data.requestedNames.map((name) => ({ name }));

  return Array.from(
    new Map(variables.map((variable) => [variable.name, variable])).values(),
  );
}

export function getRequestedDeploymentEnvVarNamesFromToolPayload(
  payload: Record<string, unknown> | null | undefined,
): string[] {
  return getRequestedDeploymentEnvVarsFromToolPayload(payload).map(
    (variable) => variable.name,
  );
}
