import {
  analyzePreviewRuntimeConfig,
  deriveRoomotePreviewDomain,
  type PreviewRuntimeConfigAnalysis,
  type PreviewRuntimeConfigFields,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';

import { resolveEffectiveDeploymentEnvVars } from './model-runtime-config';

export type PreviewRuntimeOverrideField =
  | 'previewProxyBaseUrl'
  | 'previewDomains'
  | 'roomotePreviewDomain';

export interface ResolvedPreviewRuntimeConfig {
  persisted: PreviewRuntimeConfigFields;
  effective: PreviewRuntimeConfigFields;
  analysis: PreviewRuntimeConfigAnalysis;
  sourceState: {
    previewProxyBaseUrlSource:
      | 'runtime_env'
      | 'persisted'
      | 'default'
      | 'missing';
    previewProxyBaseUrlManagedByRuntimeEnv: boolean;
  };
  overrideState: {
    hasOverrides: boolean;
    overriddenFields: PreviewRuntimeOverrideField[];
  };
}

function normalizeConfiguredValue(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();

  return trimmed || null;
}

function derivePreviewDomains(
  previewProxyBaseUrl: string | null | undefined,
): string | null {
  const hostname = deriveRoomotePreviewDomain(previewProxyBaseUrl);

  return hostname ?? null;
}

function readPersistedFields(
  deploymentEnvVars: Record<string, string>,
): PreviewRuntimeConfigFields {
  const previewProxyBaseUrl = normalizeConfiguredValue(
    deploymentEnvVars.R_PREVIEW_PROXY_BASE_URL,
  );

  return {
    previewProxyBaseUrl,
    previewDomains: derivePreviewDomains(previewProxyBaseUrl),
    roomotePreviewDomain: deriveRoomotePreviewDomain(previewProxyBaseUrl),
  };
}

function resolveEffectiveValue(params: {
  runtimeValue?: string | null;
  persistedValue: string | null;
  defaultValue?: string | null;
}): string | null {
  return (
    normalizeConfiguredValue(params.runtimeValue) ??
    params.persistedValue ??
    normalizeConfiguredValue(params.defaultValue)
  );
}

function resolvePreviewProxyBaseUrlSource(params: {
  runtimeValue?: string | null;
  persistedValue: string | null;
  defaultValue?: string | null;
}): ResolvedPreviewRuntimeConfig['sourceState']['previewProxyBaseUrlSource'] {
  if (normalizeConfiguredValue(params.runtimeValue)) {
    return 'runtime_env';
  }

  if (params.persistedValue) {
    return 'persisted';
  }

  if (normalizeConfiguredValue(params.defaultValue)) {
    return 'default';
  }

  return 'missing';
}

function buildOverrideState(params: {
  runtimeEnv: Partial<Record<string, string | undefined>>;
  persisted: PreviewRuntimeConfigFields;
  effective: PreviewRuntimeConfigFields;
}): ResolvedPreviewRuntimeConfig['overrideState'] {
  const overriddenFields: PreviewRuntimeOverrideField[] = [];

  const runtimeBaseUrl = normalizeConfiguredValue(
    params.runtimeEnv.R_PREVIEW_PROXY_BASE_URL,
  );
  if (
    runtimeBaseUrl &&
    params.persisted.previewProxyBaseUrl &&
    runtimeBaseUrl !== params.persisted.previewProxyBaseUrl &&
    runtimeBaseUrl === params.effective.previewProxyBaseUrl
  ) {
    overriddenFields.push('previewProxyBaseUrl');
  }

  const runtimeDomains = normalizeConfiguredValue(
    params.runtimeEnv.R_PREVIEW_DOMAINS,
  );
  if (
    runtimeDomains &&
    params.persisted.previewDomains &&
    runtimeDomains !== params.persisted.previewDomains &&
    runtimeDomains === params.effective.previewDomains
  ) {
    overriddenFields.push('previewDomains');
  }

  const runtimeRoomotePreviewDomain = normalizeConfiguredValue(
    params.runtimeEnv.ROOMOTE_PREVIEW_DOMAIN,
  );
  if (
    runtimeRoomotePreviewDomain &&
    params.persisted.roomotePreviewDomain &&
    runtimeRoomotePreviewDomain !== params.persisted.roomotePreviewDomain &&
    runtimeRoomotePreviewDomain === params.effective.roomotePreviewDomain
  ) {
    overriddenFields.push('roomotePreviewDomain');
  }

  return {
    hasOverrides: overriddenFields.length > 0,
    overriddenFields,
  };
}

export async function resolveEffectivePreviewRuntimeConfig(
  options: {
    runtimeEnv?: Partial<Record<string, string | undefined>>;
    deploymentEnvVars?: Record<string, string>;
    executor?: DatabaseOrTransaction;
    defaultPreviewProxyBaseUrl?: string | null;
    defaultPreviewDomains?: string | null;
    defaultRoomotePreviewDomain?: string | null;
  } = {},
): Promise<ResolvedPreviewRuntimeConfig> {
  const runtimeEnv = options.runtimeEnv ?? process.env;
  const executor = options.executor ?? db;
  const deploymentEnvVars =
    options.deploymentEnvVars ??
    (await resolveEffectiveDeploymentEnvVars({ executor }));
  const persisted = readPersistedFields(deploymentEnvVars);
  const effectivePreviewProxyBaseUrl = resolveEffectiveValue({
    runtimeValue: runtimeEnv.R_PREVIEW_PROXY_BASE_URL,
    persistedValue: persisted.previewProxyBaseUrl,
    defaultValue: options.defaultPreviewProxyBaseUrl,
  });
  const previewProxyBaseUrlSource = resolvePreviewProxyBaseUrlSource({
    runtimeValue: runtimeEnv.R_PREVIEW_PROXY_BASE_URL,
    persistedValue: persisted.previewProxyBaseUrl,
    defaultValue: options.defaultPreviewProxyBaseUrl,
  });
  const effective: PreviewRuntimeConfigFields = {
    previewProxyBaseUrl: effectivePreviewProxyBaseUrl,
    previewDomains:
      normalizeConfiguredValue(runtimeEnv.R_PREVIEW_DOMAINS) ??
      derivePreviewDomains(effectivePreviewProxyBaseUrl) ??
      normalizeConfiguredValue(options.defaultPreviewDomains),
    roomotePreviewDomain:
      normalizeConfiguredValue(runtimeEnv.ROOMOTE_PREVIEW_DOMAIN) ??
      deriveRoomotePreviewDomain(effectivePreviewProxyBaseUrl) ??
      normalizeConfiguredValue(options.defaultRoomotePreviewDomain),
  };
  const analysis = analyzePreviewRuntimeConfig(effective);

  return {
    persisted,
    effective,
    analysis,
    sourceState: {
      previewProxyBaseUrlSource,
      previewProxyBaseUrlManagedByRuntimeEnv:
        previewProxyBaseUrlSource === 'runtime_env',
    },
    overrideState: buildOverrideState({
      runtimeEnv,
      persisted,
      effective,
    }),
  };
}
