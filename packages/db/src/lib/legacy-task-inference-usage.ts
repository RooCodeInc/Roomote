import { bigint, pgTable, text } from 'drizzle-orm/pg-core';

/**
 * Compatibility query shape for consumers that still use the old table name.
 * The physical table is llm_usage_events; new code should use llmUsageEvents.
 */
export const taskInferenceUsageEvents = pgTable('llm_usage_events', {
  taskId: text('task_id').notNull(),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull(),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull(),
  totalTokens: bigint('total_tokens', { mode: 'number' }).notNull(),
  costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull(),
});
