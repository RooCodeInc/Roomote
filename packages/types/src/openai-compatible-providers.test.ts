import { describe, expect, it } from 'vitest';

import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  buildOpenAiCompatibleProviderId,
  buildOpenAiCompatibleProviderInstance,
  isOpenAiCompatibleProviderEnvVarName,
  isOpenAiCompatibleProviderId,
  listOpenAiCompatibleProviderInstancesFromEnvNames,
  normalizeOpenAiCompatibleConnectionSlug,
  parseOpenAiCompatibleBaseUrlEnvVarName,
} from './openai-compatible-providers';

describe('openai-compatible multiple connections', () => {
  it('normalizes connection names into slugs', () => {
    expect(normalizeOpenAiCompatibleConnectionSlug('Company Proxy')).toBe(
      'company-proxy',
    );
    expect(normalizeOpenAiCompatibleConnectionSlug('  local_llm  ')).toBe(
      'local-llm',
    );
    expect(normalizeOpenAiCompatibleConnectionSlug('')).toBeNull();
    expect(
      normalizeOpenAiCompatibleConnectionSlug(OPENAI_COMPATIBLE_PROVIDER_ID),
    ).toBeNull();
  });

  it('builds named provider ids and env vars', () => {
    const instance = buildOpenAiCompatibleProviderInstance('company-proxy', {
      label: 'Company Proxy',
    });

    expect(instance).toEqual({
      id: 'openai-compatible-company-proxy',
      slug: 'company-proxy',
      label: 'OpenAI-compatible (Company Proxy)',
      baseUrlEnvVarName: 'OPENAI_COMPATIBLE_COMPANY_PROXY_BASE_URL',
      apiKeyEnvVarName: 'OPENAI_COMPATIBLE_COMPANY_PROXY_API_KEY',
      labelEnvVarName: 'OPENAI_COMPATIBLE_COMPANY_PROXY_LABEL',
    });
    expect(buildOpenAiCompatibleProviderId('company-proxy')).toBe(
      'openai-compatible-company-proxy',
    );
    expect(isOpenAiCompatibleProviderId(instance.id)).toBe(true);
  });

  it('discovers instances from env var names', () => {
    const instances = listOpenAiCompatibleProviderInstancesFromEnvNames([
      'OPENAI_COMPATIBLE_BASE_URL',
      'OPENAI_COMPATIBLE_COMPANY_PROXY_BASE_URL',
      'OPENAI_COMPATIBLE_COMPANY_PROXY_API_KEY',
      'OPENROUTER_API_KEY',
    ]);

    expect(instances.map((instance) => instance.id)).toEqual([
      'openai-compatible',
      'openai-compatible-company-proxy',
    ]);
    expect(
      parseOpenAiCompatibleBaseUrlEnvVarName(
        'OPENAI_COMPATIBLE_COMPANY_PROXY_BASE_URL',
      )?.id,
    ).toBe('openai-compatible-company-proxy');
    expect(
      isOpenAiCompatibleProviderEnvVarName(
        'OPENAI_COMPATIBLE_COMPANY_PROXY_API_KEY',
      ),
    ).toBe(true);
  });
});
