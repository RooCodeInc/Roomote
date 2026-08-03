import { inArray } from 'drizzle-orm';
import {
  DEFAULT_MODEL_PROVIDER_ENV_KEYS,
  isOpenAiCompatibleProviderEnvVarName,
  parseModelProviderEnvKeys,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { decryptSecrets } from '../encryption';
import {
  environmentVariables,
  modelProviderEnvironmentVariables,
} from '../schema';

import { stringifyDecryptedEnvVarValue } from './environment-variables';

const reportedLegacyFallbackNames = new Set<string>();

function reportLegacyFallbackNames(
  modelNames: ReadonlySet<string>,
  legacyNames: readonly string[],
) {
  for (const name of legacyNames) {
    if (modelNames.has(name) || reportedLegacyFallbackNames.has(name)) {
      continue;
    }

    reportedLegacyFallbackNames.add(name);
    console.warn(
      `[model-provider-env] Using legacy persisted model-provider value name=${name}; re-save it under Settings > Models to migrate it.`,
    );
  }
}

function filterRecognizedLegacyValues(
  modelValues: Record<string, string>,
  legacyValues: Record<string, string>,
): Record<string, string> {
  const configuredLegacyNames = new Set(
    parseModelProviderEnvKeys(
      modelValues.R_MODEL_ENV_KEYS ?? legacyValues.R_MODEL_ENV_KEYS,
    ),
  );

  return Object.fromEntries(
    Object.entries(legacyValues).filter(
      ([name]) =>
        DEFAULT_MODEL_PROVIDER_ENV_KEYS.includes(name) ||
        name === 'R_MODEL_ENV_KEYS' ||
        isOpenAiCompatibleProviderEnvVarName(name) ||
        configuredLegacyNames.has(name),
    ),
  );
}

async function decryptRows(
  rows: Array<{ name: string; value: string | null }>,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};

  for (const row of rows) {
    const decryptedValue = await decryptSecrets<string>(row.value);
    const value = stringifyDecryptedEnvVarValue(decryptedValue).trim();

    if (value) {
      values[row.name] = value;
    }
  }

  return values;
}

export async function getPersistedModelProviderEnvironmentVariableNames(
  executor: DatabaseOrTransaction = db,
): Promise<string[]> {
  return Object.keys(
    await getPersistedModelProviderEnvironmentVariables(executor),
  );
}

export async function getPersistedModelProviderEnvironmentVariableValues(
  names: readonly string[],
  executor: DatabaseOrTransaction = db,
): Promise<Record<string, string>> {
  if (names.length === 0) {
    return {};
  }

  const queryNames = [...new Set([...names, 'R_MODEL_ENV_KEYS'])];
  const [modelRows, legacyRows] = await Promise.all([
    executor
      .select({
        name: modelProviderEnvironmentVariables.name,
        value: modelProviderEnvironmentVariables.value,
      })
      .from(modelProviderEnvironmentVariables)
      .where(inArray(modelProviderEnvironmentVariables.name, queryNames)),
    executor
      .select({
        name: environmentVariables.name,
        value: environmentVariables.value,
      })
      .from(environmentVariables)
      .where(inArray(environmentVariables.name, queryNames)),
  ]);
  const [modelValues, legacyValues] = await Promise.all([
    decryptRows(modelRows),
    decryptRows(legacyRows),
  ]);
  const recognizedLegacyValues = filterRecognizedLegacyValues(
    modelValues,
    legacyValues,
  );
  reportLegacyFallbackNames(
    new Set(Object.keys(modelValues)),
    Object.keys(recognizedLegacyValues),
  );
  const values = { ...recognizedLegacyValues, ...modelValues };

  return Object.fromEntries(
    names.flatMap((name) =>
      values[name] === undefined ? [] : [[name, values[name]]],
    ),
  );
}

/**
 * Loads model-provider values from the dedicated store, then fills missing
 * names from the legacy table for the N-1 compatibility release.
 */
export async function getPersistedModelProviderEnvironmentVariables(
  executor: DatabaseOrTransaction = db,
): Promise<Record<string, string>> {
  const [modelRows, legacyRows] = await Promise.all([
    executor
      .select({
        name: modelProviderEnvironmentVariables.name,
        value: modelProviderEnvironmentVariables.value,
      })
      .from(modelProviderEnvironmentVariables),
    executor
      .select({
        name: environmentVariables.name,
        value: environmentVariables.value,
      })
      .from(environmentVariables),
  ]);
  const [modelValues, legacyValues] = await Promise.all([
    decryptRows(modelRows),
    decryptRows(legacyRows),
  ]);
  const recognizedLegacyValues = filterRecognizedLegacyValues(
    modelValues,
    legacyValues,
  );
  reportLegacyFallbackNames(
    new Set(Object.keys(modelValues)),
    Object.keys(recognizedLegacyValues),
  );

  return { ...recognizedLegacyValues, ...modelValues };
}
