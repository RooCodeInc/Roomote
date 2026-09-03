import { z } from 'zod';

import {
  isBackgroundAutomationUserTargetKind,
  SCHEDULE_ONLY_BACKGROUND_AUTOMATION_FREQUENCIES,
} from './background-agents';
import { ALL_REPOSITORIES, FAST_EXECUTION } from './constants';
import { REASONING_EFFORT_VALUES } from './task-runs';

export const MANAGE_CUSTOM_AUTOMATIONS_ACTIONS = [
  'list',
  'list_models',
  'resolve_schedule',
  'create',
  'update',
  'delete',
  'run_now',
] as const;

export const manageCustomAutomationsFieldSchemas = {
  action: z.enum(MANAGE_CUSTOM_AUTOMATIONS_ACTIONS),
  automationId: z
    .string()
    .optional()
    .describe('Required for update, delete, and run_now.'),
  name: z.string().optional(),
  prompt: z
    .string()
    .optional()
    .describe(
      'Automation instructions written in product language. Do not include the automation cadence; keep it only in the schedule field. When the user intends actionable or launchable follow-up tasks and the automation has both a chat report destination and an executable workspace, instruct it to post qualifying actions as launchable suggested tasks alongside the report; otherwise keep actions as report text. Do not mention internal tool names or parameters.',
    ),
  enabled: z.boolean().optional(),
  schedule: z
    .string()
    .optional()
    .describe(
      `A five-field cron expression, natural-language recurring schedule, or one of these built-in presets: ${SCHEDULE_ONLY_BACKGROUND_AUTOMATION_FREQUENCIES.join(', ')}. Prefer a built-in preset when it matches the requested cadence.`,
    ),
  model: z
    .string()
    .nullable()
    .describe(
      'Optional provider/model launch override. Call list_models first and pass an exact returned model ID. The ID prefix selects the configured inference route; openai/... includes connected ChatGPT subscription routing. Omit to keep the deployment default; pass null on update to clear an existing override.',
    )
    .optional(),
  reasoningEffort: z
    .enum(REASONING_EFFORT_VALUES)
    .nullable()
    .describe(
      'Optional reasoning effort for the selected model. Omit to keep the model default; pass null on update to clear an existing override.',
    )
    .optional(),
  environmentId: z
    .string()
    .describe(
      `Environment UUID, "${ALL_REPOSITORIES}", or "${FAST_EXECUTION}" for Fast mode without an initial sandbox task.`,
    )
    .optional(),
  targetProvider: z
    .enum(['slack', 'discord', 'teams', 'telegram'])
    .nullable()
    .describe(
      'Destination provider. Pass null on update to clear the report destination.',
    )
    .optional(),
  targetMode: z
    .enum(['channel', 'direct_message'])
    .describe(
      'Destination mode. Use direct_message to send reports privately to the automation owner through the selected connected provider.',
    )
    .optional(),
  targetChannelId: z.string().optional(),
} satisfies z.ZodRawShape;

export const manageCustomAutomationsInputSchema = z.object(
  manageCustomAutomationsFieldSchemas,
);

export type ManageCustomAutomationsInput = z.infer<
  typeof manageCustomAutomationsInputSchema
>;

export type ManageCustomAutomationsRequest = {
  /** Path relative to the custom-automations REST base, e.g. '/models'. */
  path: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
};

export type ManageCustomAutomationsRequestResult =
  | { ok: true; request: ManageCustomAutomationsRequest }
  | { ok: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickDefined(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}

const COMPACT_AUTOMATION_ERROR_MAX_LENGTH = 500;

function compactAutomation(
  value: unknown,
  options: { includeLastError?: boolean } = {},
): Record<string, unknown> {
  const automation = asRecord(value);
  if (!automation) return {};

  const result = pickDefined(automation, [
    'id',
    'name',
    'enabled',
    'model',
    'reasoningEffort',
    'environmentId',
  ]);
  if (options.includeLastError && typeof automation.lastError === 'string') {
    result.lastError =
      automation.lastError.length <= COMPACT_AUTOMATION_ERROR_MAX_LENGTH
        ? automation.lastError
        : `${automation.lastError.slice(0, COMPACT_AUTOMATION_ERROR_MAX_LENGTH - 3)}...`;
  }
  const schedule =
    automation.scheduleMode === 'cron'
      ? automation.cronExpression
      : automation.scheduleMode;
  if (schedule !== undefined) result.schedule = schedule;

  const target = asRecord(automation.target);
  if (target?.provider !== undefined) {
    result.targetProvider = target.provider;
    const directMessage = isBackgroundAutomationUserTargetKind(
      target.targetKind,
    );
    result.targetMode = directMessage ? 'direct_message' : 'channel';
    if (!directMessage && target.externalRef !== undefined) {
      result.targetChannelId = target.externalRef;
    }
  }

  return result;
}

function compactScheduleResolution(value: unknown): Record<string, unknown> {
  const resolution = asRecord(value);
  return resolution
    ? pickDefined(resolution, [
        'status',
        'cronExpression',
        'summary',
        'clarification',
        'timeZone',
        'nextRunAt',
      ])
    : {};
}

/**
 * Reduce the authoritative API payload to the fields an agent needs for its
 * next call or user-facing report. API and UI consumers keep the full records.
 */
export function compactManageCustomAutomationsResult(
  action: ManageCustomAutomationsInput['action'],
  payload: unknown,
): Record<string, unknown> {
  const result = asRecord(payload) ?? {};

  if (
    result.status === 'ambiguous' &&
    (action === 'create' || action === 'update')
  ) {
    return {
      resolutionStatus: 'ambiguous',
      ...pickDefined(result, ['clarification']),
      ...(result.resolution
        ? { resolution: compactScheduleResolution(result.resolution) }
        : {}),
    };
  }
  if (result.error !== undefined) {
    return pickDefined(result, ['outcome', 'error', 'reason', 'clarification']);
  }

  switch (action) {
    case 'list':
      return {
        automations: Array.isArray(result.automations)
          ? result.automations.map((automation) =>
              compactAutomation(automation, { includeLastError: true }),
            )
          : [],
      };
    case 'list_models':
      return {
        models: Array.isArray(result.models)
          ? result.models.map((model) => {
              const record = asRecord(model);
              if (!record) return {};
              const metadata = asRecord(record.metadata);
              return {
                ...pickDefined(record, ['id', 'displayName']),
                ...(typeof metadata?.supportsReasoning === 'boolean'
                  ? { supportsReasoning: metadata.supportsReasoning }
                  : {}),
              };
            })
          : [],
        ...pickDefined(result, ['defaultModelId']),
      };
    case 'resolve_schedule':
      return compactScheduleResolution(result);
    case 'create':
    case 'update':
      return {
        automation: compactAutomation(result.automation),
        ...(result.resolution
          ? { resolution: compactScheduleResolution(result.resolution) }
          : {}),
      };
    case 'delete': {
      const deleted = asRecord(result.deleted);
      return {
        deleted: deleted ? pickDefined(deleted, ['id', 'name']) : {},
      };
    }
    case 'run_now':
      return pickDefined(result, ['outcome', 'taskId', 'reason', 'error']);
  }
}

/**
 * Single source of truth for mapping a manage_custom_automations call onto
 * the custom-automations REST routes. Both the sandbox MCP server and the
 * API-hosted tool build their requests from this, so action or field changes
 * cannot drift between the two transports.
 */
export function buildManageCustomAutomationsRequest(
  params: ManageCustomAutomationsInput,
): ManageCustomAutomationsRequestResult {
  switch (params.action) {
    case 'list':
      return { ok: true, request: { path: '', method: 'GET' } };
    case 'list_models':
      return { ok: true, request: { path: '/models', method: 'GET' } };
    case 'resolve_schedule':
      if (!params.schedule) {
        return { ok: false, error: 'schedule is required' };
      }
      return {
        ok: true,
        request: {
          path: '/resolve-schedule',
          method: 'POST',
          body: { schedule: params.schedule },
        },
      };
    case 'create':
    case 'update': {
      if (params.action === 'create') {
        const required = [
          'name',
          'prompt',
          'schedule',
          'environmentId',
        ] as const;
        const missing = required.find((key) => !params[key]);
        if (missing) {
          return { ok: false, error: `${missing} is required` };
        }
      } else if (!params.automationId) {
        return { ok: false, error: 'automationId is required for update' };
      }
      const body = Object.fromEntries(
        Object.entries({
          name: params.name,
          prompt: params.prompt,
          enabled:
            params.action === 'create'
              ? (params.enabled ?? true)
              : params.enabled,
          schedule: params.schedule,
          model: params.model,
          reasoningEffort: params.reasoningEffort,
          environmentId: params.environmentId,
          targetProvider: params.targetProvider,
          targetMode: params.targetMode,
          targetChannelId: params.targetChannelId,
        }).filter((entry) => entry[1] !== undefined),
      );
      return {
        ok: true,
        request:
          params.action === 'update'
            ? {
                path: `/${encodeURIComponent(params.automationId!)}`,
                method: 'PATCH',
                body,
              }
            : { path: '', method: 'POST', body },
      };
    }
    case 'delete':
    case 'run_now':
      if (!params.automationId) {
        return {
          ok: false,
          error: `automationId is required for ${params.action}`,
        };
      }
      return {
        ok: true,
        request: {
          path: `/${encodeURIComponent(params.automationId)}${
            params.action === 'run_now' ? '/run' : ''
          }`,
          method: params.action === 'delete' ? 'DELETE' : 'POST',
        },
      };
  }
}

export const MANAGE_CUSTOM_AUTOMATIONS_TOOL = {
  name: 'manage_custom_automations',
  title: 'Manage Custom Automations',
  description: `Admin-only management of deployment custom automations. List existing automations or enabled task models, resolve a cron or natural-language schedule, create or update an automation, delete an automation by exact ID, or run an enabled automation now. A run_now result with outcome "queued" confirms only that execution was queued; report it as queued or started, never completed. Pass environmentId "${FAST_EXECUTION}" to run the automation in Fast mode without starting a sandbox; Fast may still delegate a task when repository or workspace execution is required. Use list_models before setting a model override; create and update accept only exact model IDs returned by that action. Set reasoningEffort only with a selected model, using one of low, medium, high, xhigh, or max. Model IDs encode the inference route: for example, openrouter/... targets OpenRouter, while openai/... uses the deployment OpenAI route, including a connected ChatGPT subscription when configured. When the user asks an automation to DM them, set their preferred connected targetProvider and targetMode to direct_message; no targetChannelId is needed. Natural-language schedules are converted to validated five-field cron in the deployment scheduling timezone. Keep cadence only in the schedule field; do not repeat it in the stored prompt. When a user asks an automation to offer help, suggest tasks, make follow-ups actionable or launchable, or turn findings or action items into tasks, encode that intent in product language by instructing the automation to post concrete actions as launchable suggested tasks alongside its report. Do not expose runtime tool names or parameter syntax in the stored prompt. A request only to summarize or list action items is not suggested-task intent. Only promise launchable suggested tasks when the automation has both a configured chat report destination and a repository or environment for executable work; otherwise keep actions as report text and explain the missing capability. After successfully creating an automation in response to a conversational request, ask the user whether they want to run it now to test it.`,
  inputSchema: manageCustomAutomationsFieldSchemas,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;
