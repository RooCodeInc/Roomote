/**
 * Promptfoo configuration for authorship-rules compilation evals.
 *
 * This suite exercises the production authorship prompt and model against
 * deterministic guidance cases, including ambiguous inputs that should fail
 * closed instead of guessing.
 */

const AUTHORSHIP_RULES_EVAL_PROVIDER =
  process.env.AUTHORSHIP_RULES_EVAL_PROVIDER ??
  'openrouter:anthropic/claude-haiku-4.5';

const config = {
  description: 'Authorship Rules Compilation Evaluation Suite',

  prompts: ['file://prompts/compile-authorship.ts'],

  providers: [
    {
      id: AUTHORSHIP_RULES_EVAL_PROVIDER,
      config: {
        temperature: 0,
        max_tokens: 1600,
        timeout: 20000,
        headers: {
          'HTTP-Referer': 'https://roomote.dev',
          'X-Title': 'Roomote',
        },
      },
    },
  ],

  tests: ['file://datasets/convoluted-and-ambiguous.yaml'],

  outputPath: './results/eval-results.json',
};

export default config;
