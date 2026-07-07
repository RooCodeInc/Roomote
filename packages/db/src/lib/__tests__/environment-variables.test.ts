import { stringifyDecryptedEnvVarValue } from '../environment-variables';
import { decryptSecrets } from '../encryption';
import { encryptedJson } from '../custom-types';

describe('stringifyDecryptedEnvVarValue', () => {
  it('returns plain strings unchanged', () => {
    expect(stringifyDecryptedEnvVarValue('OPENAI_API_KEY=value')).toBe(
      'OPENAI_API_KEY=value',
    );
  });

  it('preserves JSON-looking objects as JSON strings', () => {
    expect(
      stringifyDecryptedEnvVarValue({
        providers: ['openai', 'anthropic'],
        enabled: true,
      }),
    ).toBe('{"providers":["openai","anthropic"],"enabled":true}');
  });

  it('preserves JSON-looking arrays as JSON strings', () => {
    expect(stringifyDecryptedEnvVarValue(['one', 'two'])).toBe('["one","two"]');
  });
});

describe('encryptedJson string handling', () => {
  it('preserves numeric-looking strings without JSON number coercion', async () => {
    const envValueType = encryptedJson<string>('value');
    const encrypted = (
      envValueType as unknown as {
        config: {
          customTypeParams: {
            toDriver: (value: string) => string | null;
          };
        };
      }
    ).config.customTypeParams.toDriver('8496921443174.9905737823573');

    expect(encrypted).not.toBeNull();
    await expect(decryptSecrets<string>(encrypted)).resolves.toBe(
      '8496921443174.9905737823573',
    );
  });
});
