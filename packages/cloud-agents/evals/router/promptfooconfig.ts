/**
 * Promptfoo configuration for routing prompt evals.
 */

const ROUTER_EVAL_PROVIDER =
  process.env.ROUTER_EVAL_PROVIDER ?? 'openrouter:anthropic/claude-haiku-4.5';

const config = {
  description: 'LLM Routing Evaluation Suite',

  prompts: ['file://prompts/routing.ts'],

  providers: [
    {
      id: ROUTER_EVAL_PROVIDER,
      config: {
        temperature: 0,
        max_tokens: 500,
        timeout: 15000,
        headers: {
          'HTTP-Referer': 'https://roomote.dev',
          'X-Title': 'Roomote',
        },
      },
    },
  ],

  defaultTest: {
    options: {
      provider: {
        config: {
          temperature: 0,
          max_tokens: 1000,
        },
      },
    },
  },

  tests: [
    'file://datasets/basic.yaml',
    'file://datasets/workspace-scope.yaml',
    'file://datasets/agent-selection.yaml',
    'file://datasets/workspace-selection.yaml',
    'file://datasets/explicit-preferences.yaml',
    'file://datasets/model-routing.yaml',
    'file://datasets/linear-guidance.yaml',
    'file://datasets/github-agent-selection.yaml',
    'file://datasets/edge-cases.yaml',
    'file://datasets/adversarial.yaml',
    'file://datasets/partial-corrections.yaml',
  ],

  outputPath: './results/eval-results.json',
};

export default config;
