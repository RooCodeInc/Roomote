export const LLM_USAGE_COST_SOURCES = [
  'opencode_message',
  'litellm_gateway',
  'missing',
] as const;

export type LlmUsageCostSource = (typeof LLM_USAGE_COST_SOURCES)[number];
