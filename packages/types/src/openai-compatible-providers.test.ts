import { describe, expect, it } from 'vitest';

import {
  OPENAI_COMPATIBLE_CONNECTION_NAME_MAX_LENGTH,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  buildOpenAiCompatibleProviderId,
  buildOpenAiCompatibleProviderInstance,
  isOpenAiCompatibleProviderEnvVarName,
  isOpenAiCompatibleProviderId,
  listOpenAiCompatibleProviderInstancesFromEnvNames,
  normalizeOpenAiCompatibleConnectionSlug,
  parseOpenAiCompatibleBaseUrlEnvVarName,
  resolveOpenAiCompatibleProtocol,
  getOpenAiCompatibleProviderEnvVarNames,
  remapOpenAiCompatibleAdditionalEnvValues,
} from './openai-compatible-providers';
import {
  collectSetupModelProviderCredentialValues,
  getSetupModelProvider,
  buildSetupModelStatus,
} from './model-provider-config';

describe('openai-compatible multiple connections', () => {
  describe('template additional-value translation', () => {
    const instance = buildOpenAiCompatibleProviderInstance('company-proxy');

    it.each(['chat-completions', 'responses'])(
      'maps %s and the optional key without changing submitted values',
      (protocol) => {
        const additionalEnvValues = Object.freeze({
          OPENAI_COMPATIBLE_PROTOCOL: protocol,
          OPENAI_COMPATIBLE_API_KEY: ' key-with-whitespace ',
          UNRELATED_VALUE: 'unchanged',
        });
        expect(
          remapOpenAiCompatibleAdditionalEnvValues({
            instance,
            connectionName: ' Company Proxy ',
            additionalEnvValues,
            templateBaseUrl: 'preserve',
          }),
        ).toEqual({
          OPENAI_COMPATIBLE_COMPANY_PROXY_LABEL: 'Company Proxy',
          OPENAI_COMPATIBLE_COMPANY_PROXY_PROTOCOL: protocol,
          OPENAI_COMPATIBLE_COMPANY_PROXY_API_KEY: ' key-with-whitespace ',
          UNRELATED_VALUE: 'unchanged',
        });
      },
    );

    it('distinguishes omitted and explicitly cleared keys', () => {
      const options = { instance, templateBaseUrl: 'omit' as const };
      expect(remapOpenAiCompatibleAdditionalEnvValues(options)).toEqual({});
      expect(
        remapOpenAiCompatibleAdditionalEnvValues({
          ...options,
          additionalEnvValues: { OPENAI_COMPATIBLE_API_KEY: '' },
        }),
      ).toEqual({ OPENAI_COMPATIBLE_COMPANY_PROXY_API_KEY: '' });
    });

    it.each(['preserve', 'omit'] as const)(
      'keeps the caller-owned %s policy for a duplicate template URL',
      (templateBaseUrl) => {
        const values = remapOpenAiCompatibleAdditionalEnvValues({
          instance,
          templateBaseUrl,
          additionalEnvValues: {
            OPENAI_COMPATIBLE_BASE_URL: 'https://duplicate.example/v1',
            OPENAI_COMPATIBLE_COMPANY_PROXY_BASE_URL:
              'https://named.example/v1',
          },
        });
        expect(values).toEqual({
          ...(templateBaseUrl === 'preserve'
            ? { OPENAI_COMPATIBLE_BASE_URL: 'https://duplicate.example/v1' }
            : {}),
          OPENAI_COMPATIBLE_COMPANY_PROXY_BASE_URL: 'https://named.example/v1',
        });
        const collect = () =>
          collectSetupModelProviderCredentialValues({
            provider: getSetupModelProvider(instance.id),
            apiKey: 'https://primary.example/v1',
            additionalEnvValues: values,
            isEnvVarSatisfied: () => false,
            action: 'save it',
          });
        if (templateBaseUrl === 'preserve') {
          expect(collect).toThrow(
            'does not accept a OPENAI_COMPATIBLE_BASE_URL value',
          );
        } else {
          expect(collect().values).toEqual([
            {
              name: instance.baseUrlEnvVarName,
              value: 'https://primary.example/v1',
            },
          ]);
        }
      },
    );

    it('retains named fields and their insertion-order precedence over injected values', () => {
      expect(
        remapOpenAiCompatibleAdditionalEnvValues({
          instance,
          connectionName: 'Company Proxy',
          templateBaseUrl: 'omit',
          additionalEnvValues: {
            OPENAI_COMPATIBLE_API_KEY: 'template-key',
            OPENAI_COMPATIBLE_COMPANY_PROXY_API_KEY: 'named-key',
            OPENAI_COMPATIBLE_COMPANY_PROXY_LABEL: 'Submitted label',
          },
        }),
      ).toEqual({
        OPENAI_COMPATIBLE_COMPANY_PROXY_LABEL: 'Submitted label',
        OPENAI_COMPATIBLE_COMPANY_PROXY_API_KEY: 'named-key',
      });
    });
  });

  it('defaults legacy connections and keeps named save/read/delete configuration isolated', () => {
    expect(resolveOpenAiCompatibleProtocol(undefined)).toBe('chat-completions');
    const provider = getSetupModelProvider('openai-compatible-native');
    const saved = collectSetupModelProviderCredentialValues({
      provider,
      apiKey: 'https://native.example/v1',
      additionalEnvValues: { OPENAI_COMPATIBLE_NATIVE_PROTOCOL: 'responses' },
      isEnvVarSatisfied: () => false,
      action: 'save it',
    });
    expect(saved.values).toEqual([
      {
        name: 'OPENAI_COMPATIBLE_NATIVE_BASE_URL',
        value: 'https://native.example/v1',
      },
      { name: 'OPENAI_COMPATIBLE_NATIVE_PROTOCOL', value: 'responses' },
    ]);
    const values = Object.fromEntries(
      saved.values.map(({ name, value }) => [name, value]),
    );
    const status = buildSetupModelStatus({
      persistedEnvVarNames: Object.keys(values),
      persistedEnvVarValues: values,
    });
    expect(
      status.providers.find((item) => item.id === provider.id)
        ?.additionalEnvValues,
    ).toMatchObject({ OPENAI_COMPATIBLE_NATIVE_PROTOCOL: 'responses' });
    const edited = collectSetupModelProviderCredentialValues({
      provider,
      additionalEnvValues: {
        OPENAI_COMPATIBLE_NATIVE_PROTOCOL: 'chat-completions',
      },
      isEnvVarSatisfied: () => true,
      action: 'save it',
    });
    expect(edited.values).toEqual([
      { name: 'OPENAI_COMPATIBLE_NATIVE_PROTOCOL', value: 'chat-completions' },
    ]);
    const deletedNames = getOpenAiCompatibleProviderEnvVarNames(provider.id);
    expect(deletedNames).toContain('OPENAI_COMPATIBLE_NATIVE_PROTOCOL');
    expect(deletedNames).not.toContain('OPENAI_COMPATIBLE_PROTOCOL');
    expect(deletedNames).not.toContain('OPENAI_COMPATIBLE_OTHER_PROTOCOL');
    expect(() =>
      collectSetupModelProviderCredentialValues({
        provider,
        additionalEnvValues: { OPENAI_COMPATIBLE_NATIVE_PROTOCOL: 'invalid' },
        isEnvVarSatisfied: () => true,
        action: 'save it',
      }),
    ).toThrow('API protocol');
  });
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

  it('rejects overlong connection names without scanning unbounded input', () => {
    const overlong = `a${'-'.repeat(OPENAI_COMPATIBLE_CONNECTION_NAME_MAX_LENGTH)}a`;
    expect(normalizeOpenAiCompatibleConnectionSlug(overlong)).toBeNull();
    expect(
      normalizeOpenAiCompatibleConnectionSlug(`a${'-'.repeat(25_000)}a`),
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
      protocolEnvVarName: 'OPENAI_COMPATIBLE_COMPANY_PROXY_PROTOCOL',
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
