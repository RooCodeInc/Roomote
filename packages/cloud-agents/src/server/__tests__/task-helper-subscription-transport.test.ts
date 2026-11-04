import { createServer } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import {
  AGENT_SAFETY_STOP_CODE,
  AGENT_SAFETY_STOP_TEXT,
  isAgentSafetyStop,
} from '@roomote/types';
import { leaseOpenCodeSdkServer } from '../opencode-runtime';
import { OPENCODE_PLUGIN_SEED_DIR_ENV } from '../opencode-plugin-seed';
import { writeOpenCodePluginSeedFixture } from './helpers/opencode-plugin-seed-fixture';

// Real pinned OpenCode and its built-in OAuth plugins, with synthetic auth and
// a local gateway denial. No live provider credentials or paid inference.
describe.skipIf(process.env.ROOMOTE_TEST_OPENCODE_SUBSCRIPTIONS !== '1')(
  'task helper subscription transport',
  () => {
    it.each(['openai', 'github-copilot'])(
      'keeps %s OAuth off the direct transport and observes the gateway stop',
      async (provider) => {
        const home = mkdtempSync(
          join(tmpdir(), 'roomote-subscription-transport-'),
        );
        const dataHome = join(home, 'shared-data');
        const oauth = JSON.stringify(
          Object.fromEntries(
            ['openai', 'github-copilot'].map((id) => [
              id,
              {
                type: 'oauth',
                access: 'synthetic-access',
                refresh: 'synthetic-refresh',
                expires: Date.now() + 600_000,
              },
            ]),
          ),
        );
        for (const dir of [
          join(dataHome, 'opencode'),
          join(home, '.local', 'share', 'opencode'),
        ]) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'auth.json'), oauth);
        }
        const seed = join(home, 'seed');
        writeOpenCodePluginSeedFixture(seed, '1.18.30');
        const requests: Array<{
          url: string;
          authorization: string | undefined;
        }> = [];
        const gateway = createServer((req, res) => {
          if (req.method === 'POST')
            requests.push({
              url: req.url ?? '',
              authorization: req.headers.authorization,
            });
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: AGENT_SAFETY_STOP_CODE,
                message: AGENT_SAFETY_STOP_TEXT,
                type: 'invalid_request_error',
              },
            }),
          );
        });
        await new Promise<void>((resolve) =>
          gateway.listen(0, '127.0.0.1', resolve),
        );
        const address = gateway.address();
        if (!address || typeof address === 'string')
          throw new Error('Gateway did not bind');
        const model = `${provider}/gpt-5.4`;
        let lease:
          | Awaited<ReturnType<typeof leaseOpenCodeSdkServer>>
          | undefined;
        let client: ReturnType<typeof createOpencodeClient> | undefined;
        let sessionId: string | undefined;
        try {
          lease = await leaseOpenCodeSdkServer({
            env: {
              HOME: home,
              XDG_CONFIG_HOME: join(home, 'config'),
              XDG_CACHE_HOME: join(home, 'cache'),
              XDG_DATA_HOME: dataHome,
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                model,
                small_model: model,
                provider: {
                  [provider]: {
                    models: {
                      'gpt-5.4': {
                        name: 'Transport fixture',
                        limit: { context: 272_000, output: 8_192 },
                        modalities: { input: ['text'], output: ['text'] },
                      },
                    },
                  },
                },
              }),
              R_MODEL: model,
              R_SMALL_MODEL: model,
              OPENCODE_AUTH_CONTENT: oauth,
              ROOMOTE_TASK_INFERENCE_GATEWAY: `http://127.0.0.1:${address.port}/api/inference`,
              ROOMOTE_TASK_INFERENCE_TOKEN: 'synthetic-run-token',
              R_INFERENCE_GATEWAY_CHATGPT: provider === 'openai' ? '1' : '',
              OPENCODE_DISABLE_AUTOUPDATE: '1',
              OPENCODE_DISABLE_MODELS_FETCH: '1',
              OPENCODE_DISABLE_DEFAULT_PLUGINS: undefined,
              [OPENCODE_PLUGIN_SEED_DIR_ENV]: seed,
            },
            ephemeral: true,
            useConfiguredServer: false,
            startTimeoutMs: 15_000,
          });
          client = createOpencodeClient({ baseUrl: lease.url });
          const session = await client.session.create(
            { directory: home, title: 'Gateway auth transport fixture' },
            { signal: AbortSignal.timeout(10_000) },
          );
          if (session.error || !session.data)
            throw new Error('Could not create transport test session');
          sessionId = session.data.id;
          const result = await client.session.prompt(
            {
              sessionID: sessionId,
              directory: home,
              model: { providerID: provider, modelID: 'gpt-5.4' },
              parts: [{ type: 'text', text: 'Say done.' }],
            },
            { signal: AbortSignal.timeout(10_000) },
          );
          expect(requests).toHaveLength(1);
          expect(requests[0]).toMatchObject({
            authorization: 'Bearer synthetic-run-token',
          });
          expect(requests[0]?.url).toBe(
            provider === 'openai'
              ? '/api/inference/openai-chatgpt/v1/responses'
              : '/api/inference/github-copilot/responses',
          );
          expect(
            isAgentSafetyStop(result.error ?? result.data?.info.error),
          ).toBe(true);
          expect(
            readFileSync(join(dataHome, 'opencode', 'auth.json'), 'utf8'),
          ).toBe(oauth);
        } finally {
          if (sessionId && client)
            await client.session
              .abort(
                { sessionID: sessionId, directory: home },
                { signal: AbortSignal.timeout(2_000) },
              )
              .catch(() => undefined);
          lease?.release();
          gateway.closeAllConnections();
          await new Promise<void>((resolve) => gateway.close(() => resolve()));
          rmSync(home, { recursive: true, force: true });
        }
      },
      45_000,
    );
  },
);
