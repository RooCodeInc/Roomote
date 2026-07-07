import YAML from 'yaml';

import {
  type EnvironmentConfig,
  environmentConfigSchema,
} from '@roomote/types';

import { createEnvironment, updateEnvironment } from './tasks-api-client.js';
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
    const normalized = normalizeDefinition(
      params.definition,
      params.format ?? 'auto',
    );
    const parsedConfig = environmentConfigSchema.safeParse(normalized);

    if (!parsedConfig.success) {
      return errorResult(
        `Invalid environment configuration: ${parsedConfig.error.issues
          .map((issue) => issue.message)
          .join(', ')}`,
      );
    }

    const finalConfig = applyOverrides(parsedConfig.data, {
      name: params.name,
      description: params.description,
    });

    const finalParse = environmentConfigSchema.safeParse(finalConfig);
    if (!finalParse.success) {
      return errorResult(
        `Invalid environment configuration: ${finalParse.error.issues
          .map((issue) => issue.message)
          .join(', ')}`,
      );
    }

    const result = await createEnvironment(config, {
      config: finalParse.data,
    });

    const missingCount = result.missingRepositories.length;
    const message =
      missingCount > 0
        ? `Environment "${result.name}" created. ${missingCount} repository mapping(s) were skipped because they are not linked to this deployment.`
        : `Environment "${result.name}" created successfully.`;

    return successResult({
      environmentId: result.environmentId,
      name: result.name,
      missingRepositories: result.missingRepositories,
      message,
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

    const normalized = normalizeDefinition(
      params.definition,
      params.format ?? 'auto',
    );
    const parsedConfig = environmentConfigSchema.safeParse(normalized);

    if (!parsedConfig.success) {
      return errorResult(
        `Invalid environment configuration: ${parsedConfig.error.issues
          .map((issue) => issue.message)
          .join(', ')}`,
      );
    }

    const finalConfig = applyOverrides(parsedConfig.data, {
      name: params.name,
      description: params.description,
    });

    const finalParse = environmentConfigSchema.safeParse(finalConfig);
    if (!finalParse.success) {
      return errorResult(
        `Invalid environment configuration: ${finalParse.error.issues
          .map((issue) => issue.message)
          .join(', ')}`,
      );
    }

    const result = await updateEnvironment(config, {
      environmentId,
      config: finalParse.data,
    });

    const missingCount = result.missingRepositories.length;
    const message =
      missingCount > 0
        ? `Environment "${result.name}" updated. ${missingCount} repository mapping(s) were skipped because they are not linked to this deployment.`
        : `Environment "${result.name}" updated successfully.`;

    return successResult({
      environmentId: result.environmentId,
      name: result.name,
      missingRepositories: result.missingRepositories,
      message,
    });
  } catch (error) {
    return catchError(error);
  }
}
