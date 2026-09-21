import YAML from 'yaml';

import {
  type EnvironmentConfig,
  environmentConfigSchema,
  getUnresolvedEnvironmentRecipeError,
} from '@roomote/types';

import {
  createEnvironment,
  recordEnvironmentVerification,
  updateEnvironment,
} from './tasks-api-client.js';
import { catchError, errorResult, successResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

type ParseFormat = 'auto' | 'json' | 'yaml';

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const codeFence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/;
  const match = codeFence.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function parseDefinitionString(
  input: string,
  format: ParseFormat,
): Record<string, unknown> {
  const raw = stripCodeFence(input);
  if (!raw.trim()) {
    throw new Error('definition string cannot be empty');
  }

  const parseJson = (): Record<string, unknown> => {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON definition must be an object');
    }
    return parsed as Record<string, unknown>;
  };

  const parseYaml = (): Record<string, unknown> => {
    const parsed = YAML.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('YAML definition must be an object');
    }
    return parsed as Record<string, unknown>;
  };

  if (format === 'json') {
    return parseJson();
  }

  if (format === 'yaml') {
    return parseYaml();
  }

  try {
    return parseJson();
  } catch {
    return parseYaml();
  }
}

function normalizeDefinition(
  definition: unknown,
  format: ParseFormat,
): Record<string, unknown> {
  if (typeof definition === 'string') {
    return parseDefinitionString(definition, format);
  }

  if (
    !definition ||
    typeof definition !== 'object' ||
    Array.isArray(definition)
  ) {
    throw new Error('definition must be an object or YAML/JSON string');
  }

  return definition as Record<string, unknown>;
}

function applyOverrides(
  config: EnvironmentConfig,
  params: { name?: string; description?: string },
): EnvironmentConfig {
  const name = params.name?.trim();
  const hasDescription = params.description !== undefined;

  if (!name && !hasDescription) {
    return config;
  }

  return {
    ...config,
    ...(name ? { name } : {}),
    ...(hasDescription ? { description: params.description } : {}),
  };
}

function parseFinalDefinition(params: {
  definition: unknown;
  format?: ParseFormat;
  name?: string;
  description?: string;
}): EnvironmentConfig {
  const normalized = normalizeDefinition(
    params.definition,
    params.format ?? 'auto',
  );
  const parsedConfig = environmentConfigSchema.safeParse(normalized);
  if (!parsedConfig.success) {
    throw new Error(
      `Invalid environment configuration: ${parsedConfig.error.issues.map((issue) => issue.message).join(', ')}`,
    );
  }
  const unresolvedRecipeError = getUnresolvedEnvironmentRecipeError(
    parsedConfig.data,
  );
  if (unresolvedRecipeError) {
    throw new Error(unresolvedRecipeError);
  }
  return applyOverrides(parsedConfig.data, params);
}

function buildEnvironmentSummary(config: EnvironmentConfig): {
  summary: {
    name: string;
    repositories: number;
    setupCommands: number;
    dockerProjects: number;
    environmentRecipe: string | null;
    maximumConfiguredSetupMinutes: number;
  };
} {
  const setupCommands = config.repositories.flatMap(
    (repository) => repository.commands ?? [],
  );
  const configuredSeconds =
    setupCommands.reduce((total, command) => total + command.timeout, 0) +
    (config.docker_projects ?? []).reduce(
      (total, project) => total + (project.startup_timeout_seconds ?? 600),
      0,
    ) +
    (config.environment_recipe ? 5_400 : 0);
  return {
    summary: {
      name: config.name,
      repositories: config.repositories.length,
      setupCommands: setupCommands.length,
      dockerProjects: config.docker_projects?.length ?? 0,
      environmentRecipe: config.environment_recipe?.type ?? null,
      maximumConfiguredSetupMinutes: Math.ceil(configuredSeconds / 60),
    },
  };
}

export async function handlePreviewEnvironment(params: {
  definition: unknown;
  format?: ParseFormat;
  name?: string;
  description?: string;
  environmentId?: string;
}): Promise<ToolResult> {
  try {
    const finalConfig = parseFinalDefinition(params);
    const preview = buildEnvironmentSummary(finalConfig);
    return successResult({
      ...preview,
      action: params.environmentId ? 'update' : 'create',
      impact: params.environmentId
        ? 'Running tasks keep their current workspace. New tasks use this definition; runtime-affecting changes clear verification and rebuild the cached baseline.'
        : 'Creates an unverified reusable environment. A fresh task must build and verify it before it is ready for analysis.',
      confirmationRequired: true,
      message:
        'Tell the user what this environment change will do, including its maximum configured setup time and disruption impact, then ask whether to proceed. Only create or update after the user responds affirmatively.',
    });
  } catch (error) {
    return catchError(error);
  }
}

export async function handleCreateEnvironment(
  params: {
    definition: unknown;
    format?: ParseFormat;
    name?: string;
    description?: string;
  },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const finalConfig = parseFinalDefinition(params);
    const result = await createEnvironment(config, { config: finalConfig });

    return successResult({
      environmentId: result.environmentId,
      name: result.name,
      message: `Environment "${result.name}" created successfully.`,
    });
  } catch (error) {
    return catchError(error);
  }
}

export async function handleUpdateEnvironment(
  params: {
    environmentId: string;
    definition: unknown;
    format?: ParseFormat;
    name?: string;
    description?: string;
  },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const environmentId = params.environmentId.trim();
    if (!environmentId) {
      return errorResult('environmentId is required for update');
    }

    const finalConfig = parseFinalDefinition(params);
    const result = await updateEnvironment(config, {
      environmentId,
      config: finalConfig,
    });

    return successResult({
      environmentId: result.environmentId,
      name: result.name,
      message: `Environment "${result.name}" updated successfully.`,
    });
  } catch (error) {
    return catchError(error);
  }
}

export async function handleRecordVerification(
  params: {
    environmentId: string;
    success: boolean;
    error?: string;
  },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const environmentId = params.environmentId.trim();
    if (!environmentId) {
      return errorResult('environmentId is required for record_verification');
    }

    const result = await recordEnvironmentVerification(config, {
      environmentId,
      success: params.success,
      error: params.error,
    });

    return successResult({
      environmentId: result.environmentId,
      isVerified: result.isVerified,
      message: result.isVerified
        ? 'Environment verification recorded as successful.'
        : 'Environment verification recorded as failed.',
    });
  } catch (error) {
    return catchError(error);
  }
}
