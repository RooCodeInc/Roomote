/**
 * Promptfoo configuration for the follow-up classification prompt.
 *
 * This config evaluates the classifyFollowUp prompt, which determines
 * whether a user is confirming, cancelling, or correcting a routing
 * suggestion. Introduced in CLO-900 (verify-before-confirm flow).
 *
 * Run with: pnpm eval:router:followup
 */

const ROUTER_FOLLOWUP_EVAL_PROVIDER =
  process.env.ROUTER_FOLLOWUP_EVAL_PROVIDER ??
  process.env.ROUTER_EVAL_PROVIDER ??
  'openrouter:anthropic/claude-haiku-4.5';

const config = {
  description: 'Follow-Up Classification Evaluation Suite (CLO-900)',

  prompts: ['file://prompts/followup.ts'],

  providers: [
    {
      id: ROUTER_FOLLOWUP_EVAL_PROVIDER,
      config: {
        temperature: 0,
        max_tokens: 200,
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
          max_tokens: 200,
        },
      },
    },
  },

  tests: ['file://datasets/followup-classification.yaml'],

  outputPath: './results/eval-followup-results.json',
};

export default config;
