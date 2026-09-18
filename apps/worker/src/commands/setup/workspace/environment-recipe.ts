import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { EnvironmentRecipe } from '@roomote/types';
import { hasResolvedEnvironmentRecipe } from '@roomote/types';

import {
  CommandExecutor,
  ExecutionError,
  type ExecutionResult,
} from '../../../command-executor';
import type { StartupLogger } from '../../../logging';
import { getRecipeWorkerAdapter } from '../../../recipes/registry';
import { getRoomoteConfig } from '../../../mcp/roomote-mcp-server/config.js';
import { finalizeEnvironmentRecipeResolution } from '../../../mcp/roomote-mcp-server/tasks-api-client.js';

/**
 * Environment recipe setup driven by the worker recipe registry. Resolved
 * recipes restore from their persisted lock only; unresolved recipes resolve
 * from official repositories, then finalize through the trusted API path so
 * the environment keeps its current verification binding.
 */
/**
 * Run a command plan from the recipe registry, driving setup-status
 * lifecycle callbacks.
 */
async function runRecipeCommandPlan(
  logger: StartupLogger,
  input: {
    planName: string;
    commands: readonly {
      name: string;
      run: string;
      timeout?: number;
      continue_on_error?: boolean;
      retries?: number;
      detached?: boolean;
      logfile?: string;
    }[];
    workspacePath: string;
    envVars: Record<string, string | undefined>;
    onCommandStart?: (recipeName: string, commandName: string) => void;
    onCommandResult?: (recipeName: string, result: ExecutionResult) => void;
  },
): Promise<void> {
  const executor = new CommandExecutor(input.workspacePath, input.envVars);

  for (const command of input.commands) {
    input.onCommandStart?.(input.planName, command.name);
    try {
      const result = await executor.execute({
        timeout: 600,
        continue_on_error: false,
        ...command,
      });
      input.onCommandResult?.(input.planName, result);
    } catch (error) {
      if (error instanceof ExecutionError) {
        input.onCommandResult?.(input.planName, error.result);
      }
      throw error;
    }
  }
}

/**
 * Command plan names for setup-status initialization before execution starts.
 */
export function getEnvironmentRecipeSetupPlan(recipe: EnvironmentRecipe): {
  planName: string;
  commandNames: string[];
} {
  const adapter = getRecipeWorkerAdapter(recipe.type);
  if (!adapter) {
    return { planName: recipe.type, commandNames: [] };
  }
  const commands = hasResolvedEnvironmentRecipe(recipe)
    ? adapter.buildRestoreCommands({ recipe, recipePath: '.roomote/recipes' })
    : adapter.buildResolutionCommands({
        recipe,
        recipePath: '.roomote/recipes',
      });
  return {
    planName: adapter.setupPlanName,
    commandNames: commands.map((command) => command.name),
  };
}

export async function setupEnvironmentRecipe(
  logger: StartupLogger,
  input: {
    recipe: EnvironmentRecipe;
    workspacePath: string;
    envVars: Record<string, string | undefined>;
    environmentId: string;
    onCommandStart?: (recipeName: string, commandName: string) => void;
    onCommandResult?: (recipeName: string, result: ExecutionResult) => void;
  },
): Promise<void> {
  const adapter = getRecipeWorkerAdapter(input.recipe.type);
  if (!adapter) {
    throw new Error(
      `No worker adapter registered for environment recipe type ${input.recipe.type}.`,
    );
  }
  const planName = adapter.setupPlanName;

  const recipeHash = input.recipe.request_fingerprint.slice(0, 16);
  const recipePath = join(
    input.workspacePath,
    '.roomote',
    'recipes',
    recipeHash,
  );
  await mkdir(recipePath, { recursive: true });

  let recipe = input.recipe;
  let resolutionPreparedRuntime = false;

  if (!hasResolvedEnvironmentRecipe(recipe)) {
    logger.userLog.log(
      'Resolving the environment recipe from official repositories',
    );
    await runRecipeCommandPlan(logger, {
      planName,
      commands: adapter.buildResolutionCommands({ recipe, recipePath }),
      workspacePath: input.workspacePath,
      envVars: input.envVars,
      onCommandStart: input.onCommandStart,
      onCommandResult: input.onCommandResult,
    });

    const resolved = await adapter.readResolvedRecipe({ recipe, recipePath });
    if (!resolved || !hasResolvedEnvironmentRecipe(resolved)) {
      throw new Error(
        'Environment recipe resolution did not produce a usable resolution. No partial resolution is persisted.',
      );
    }

    const config = getRoomoteConfig();
    if (!config) {
      throw new Error(
        'Worker platform credentials are unavailable; cannot finalize the environment recipe.',
      );
    }

    await finalizeEnvironmentRecipeResolution(config, {
      environmentId: input.environmentId,
      recipe: resolved,
    });
    recipe = resolved;
    // Resolution plans must prove the result from a clean restore before it is
    // finalized, so the current workspace is already ready. Do not repeat the
    // potentially hour-long restore immediately after resolution.
    resolutionPreparedRuntime = true;
  }

  if (!resolutionPreparedRuntime) {
    await adapter.materializeResolution?.({ recipe, recipePath });

    // Resolved recipes restore from their persisted resolution only;
    // dependency resolution never reruns in a fresh task.
    await runRecipeCommandPlan(logger, {
      planName,
      commands: adapter.buildRestoreCommands({ recipe, recipePath }),
      workspacePath: input.workspacePath,
      envVars: input.envVars,
      onCommandStart: input.onCommandStart,
      onCommandResult: input.onCommandResult,
    });
  }

  await adapter.afterRestore?.({
    recipe,
    recipePath,
    workspacePath: input.workspacePath,
  });
}
