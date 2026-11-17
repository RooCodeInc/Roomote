import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertInferenceProviderConnection } from './provider-validation';

// Opt in to the real pinned OpenCode helper. The provider is a local HTTP
// fixture; no live credentials, paid inference, or persisted configuration.
describe.skipIf(process.env.ROOMOTE_TEST_OPENCODE_PROVIDER_VALIDATION !== '1')(
  'native inference provider validation',
  () => {
    let home: string;
    let status = 401;
    const requests: string[] = [];
    const provider = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      req.resume();
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            type:
              status === 402 ? 'insufficient_quota' : 'authentication_error',
            message: status === 402 ? 'Insufficient credits.' : 'Rejected.',
          },
        }),
      );
    });

    beforeAll(async () => {
      home = await mkdtemp(join(tmpdir(), 'roomote-provider-validation-'));
      await new Promise<void>((resolve) =>
        provider.listen(0, '127.0.0.1', resolve),
      );
      const address = provider.address();
      if (!address || typeof address === 'string')
        throw new Error('No local provider');
      vi.stubEnv('HOME', home);
      vi.stubEnv('XDG_CONFIG_HOME', join(home, 'config'));
      vi.stubEnv('XDG_DATA_HOME', join(home, 'data'));
      vi.stubEnv('XDG_CACHE_HOME', join(home, 'cache'));
      vi.stubEnv('ANTHROPIC_BASE_URL', `http://127.0.0.1:${address.port}`);
      vi.stubEnv('OPENCODE_DISABLE_AUTOUPDATE', '1');
      vi.stubEnv('OPENCODE_DISABLE_MODELS_FETCH', '1');
    });

    afterAll(async () => {
      vi.unstubAllEnvs();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      if (home) await rm(home, { recursive: true, force: true });
    });

    const validate = () =>
      assertInferenceProviderConnection({
        providerLabel: 'Anthropic',
        providerEnvVarNames: ['ANTHROPIC_API_KEY'],
        modelId: 'anthropic/claude-sonnet-4-5',
        persistedEnv: {},
        credentialValues: [
          { name: 'ANTHROPIC_API_KEY', value: 'synthetic-local-only' },
        ],
      });

    it.each([401, 403])(
      'blocks a key rejected with HTTP %s',
      async (code) => {
        status = code;
        requests.length = 0;
        await expect(validate()).rejects.toMatchObject({
          code: 'invalid_credentials',
          retryable: false,
        });
        expect(requests).toEqual(['POST /messages']);
      },
      45_000,
    );

    it('keeps exhausted credits as a non-blocking warning', async () => {
      status = 402;
      requests.length = 0;
      await expect(validate()).resolves.toMatchObject({
        code: 'insufficient_credits',
      });
      expect(requests).toEqual(['POST /messages']);
    }, 45_000);
  },
);
