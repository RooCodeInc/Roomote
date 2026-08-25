import { buildOpenCodeHarnessEnv } from '../env';

describe('buildOpenCodeHarnessEnv', () => {
  it('passes planning model and reasoning env vars to the OpenCode harness', () => {
    const env = buildOpenCodeHarnessEnv({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_PLANNING_MODEL: 'openrouter/anthropic/claude-opus-4.7',
      R_MODEL_REASONING_EFFORT: 'medium',
      R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      R_CHATGPT_FAST_MODE: '1',
      OPENROUTER_API_KEY: 'openrouter-key',
    });

    expect(env).toMatchObject({
      R_MODEL: 'openrouter/openai/gpt-5.4',
      R_PLANNING_MODEL: 'openrouter/anthropic/claude-opus-4.7',
      R_MODEL_REASONING_EFFORT: 'medium',
      R_PLANNING_MODEL_REASONING_EFFORT: 'high',
      R_CHATGPT_FAST_MODE: '1',
      OPENROUTER_API_KEY: 'openrouter-key',
    });
  });

  it('does not forward direct OAuth content to the task harness', () => {
    const env = buildOpenCodeHarnessEnv({
      OPENCODE_AUTH_CONTENT: JSON.stringify({
        openai: { type: 'oauth', refresh: 'rt', access: 'at', expires: 1 },
      }),
    });

    expect(env).not.toHaveProperty('OPENCODE_AUTH_CONTENT');
  });
});
